import { authenticate } from '@google-cloud/local-auth';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { OAuth2Client } from 'google-auth-library';
import path from 'path';
import { AuthConfig, AuthenticationError, OAuthClientConfig, TokenData, TokenExpiredError } from './types.js';

/**
 * AuthManager with multi-account PROFILES.
 *
 * Each Google account/channel is a named profile with its own token at
 * `src/auth/tokens/<profile>.json`. The active profile is chosen by (in order):
 *   1. the `YT_PROFILE` env var, else
 *   2. the in-memory profile set by switch_profile in THIS process, else
 *   3. `src/auth/active-profile` — the seed default for a new process, else
 *   4. "default".
 *
 * Step 2 keeps the profile per session. Every MCP session runs its own server
 * process, so a switch in one session cannot change the channel another session
 * reads. `switch_profile { persist: true }` also rewrites the seed file, which
 * is the only way to change the starting profile of future sessions.
 * A single OAuth client (credentials.json) is shared across profiles — only the
 * user token differs, so every profile keeps using `channel==MINE` and works for
 * Brand Accounts, Gmail, or Workspace channels alike.
 *
 * Backward compatible: if a profile has no token file but a legacy
 * `src/auth/token.json` exists, the "default" profile falls back to it.
 */
export class AuthManager {
  private readonly AUTH_DIR = path.join(process.cwd(), 'src', 'auth');
  private readonly CREDENTIALS_PATH = path.join(this.AUTH_DIR, 'credentials.json');
  private readonly LEGACY_TOKEN_PATH = path.join(this.AUTH_DIR, 'token.json');
  private readonly TOKENS_DIR = path.join(this.AUTH_DIR, 'tokens');
  private readonly ACTIVE_FILE = path.join(this.AUTH_DIR, 'active-profile');
  private readonly META_PATH = path.join(this.AUTH_DIR, 'profiles.json');
  private readonly SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtubepartner'
  ];

  private authClient: OAuth2Client | null = null;
  private loadedProfile: string | null = null;   // which profile authClient was built from
  private sessionProfile: string | null = null;  // per-process override set by switch_profile

  constructor() {}

  // ---------- profiles ----------

  /** The active profile: YT_PROFILE env → this session → active-profile file → "default". */
  getActiveProfile(): string {
    const env = process.env.YT_PROFILE?.trim();
    if (env) return this.sanitizeProfile(env);
    if (this.sessionProfile) return this.sessionProfile;
    return this.getSeedProfile();
  }

  /** The starting profile for a new process, read from the shared file. */
  getSeedProfile(): string {
    try {
      const p = readFileSync(this.ACTIVE_FILE, 'utf8').trim();
      if (p) return this.sanitizeProfile(p);
    } catch { /* no file yet */ }
    return 'default';
  }

  /**
   * Switch the active profile for THIS process and drop the cached client.
   * `persist` also rewrites the shared seed file, which changes the starting
   * profile of every future session. Leave it false to keep the switch local.
   */
  setActiveProfile(name: string, persist = false): string {
    const clean = this.sanitizeProfile(name);
    if (persist) {
      mkdirSync(this.AUTH_DIR, { recursive: true });
      writeFileSync(this.ACTIVE_FILE, clean, 'utf8');
    }
    this.sessionProfile = clean;
    this.authClient = null;
    this.loadedProfile = null;
    return clean;
  }

  /** Does the given profile have a usable token on disk? */
  hasToken(profile: string): boolean {
    const clean = this.sanitizeProfile(profile);
    if (existsSync(this.tokenPathFor(clean))) return true;
    return clean === 'default' && existsSync(this.LEGACY_TOKEN_PATH);
  }

  /** List known profiles (token files + legacy default), marking the active one. */
  listProfiles(): { name: string; active: boolean; channelTitle?: string; channelId?: string }[] {
    const active = this.getActiveProfile();
    const names = new Set<string>();
    try {
      for (const f of readdirSync(this.TOKENS_DIR)) {
        if (f.endsWith('.json')) names.add(f.slice(0, -5));
      }
    } catch { /* no tokens dir yet */ }
    if (existsSync(this.LEGACY_TOKEN_PATH)) names.add('default');
    if (names.size === 0) names.add(active);   // surface the active name even if unauthed

    const meta = this.readMeta();
    return [...names].sort().map(name => ({
      name,
      active: name === active,
      channelTitle: meta[name]?.title,
      channelId: meta[name]?.channelId,
    }));
  }

  private sanitizeProfile(name: string): string {
    const clean = (name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) throw new AuthenticationError('Invalid profile name');
    return clean;
  }

  private tokenPathFor(profile: string): string {
    return path.join(this.TOKENS_DIR, `${profile}.json`);
  }

  /** Where a profile's token lives (with legacy fallback for "default"). Defaults to the ACTIVE profile. */
  private resolveTokenPath(profileName?: string): string {
    const profile = profileName ?? this.getActiveProfile();
    const p = this.tokenPathFor(profile);
    if (existsSync(p)) return p;
    if (profile === 'default' && existsSync(this.LEGACY_TOKEN_PATH)) return this.LEGACY_TOKEN_PATH;
    return p; // may not exist yet → triggers the auth flow
  }

  private readMeta(): Record<string, { channelId?: string; title?: string }> {
    try {
      return JSON.parse(readFileSync(this.META_PATH, 'utf8'));
    } catch {
      return {};
    }
  }

  // ---------- OAuth client config ----------

  // Google OAuth credential files store the client under `web` (Web app) or
  // `installed` (Desktop app). Return whichever is present.
  private getClientConfig(credentials: AuthConfig): OAuthClientConfig {
    const clientConfig = credentials.installed ?? credentials.web;
    if (!clientConfig) {
      throw new AuthenticationError(
        'Invalid credentials file: expected an "installed" or "web" OAuth client.'
      );
    }
    return clientConfig;
  }

  async getAuthClient(): Promise<OAuth2Client> {
    const profile = this.getActiveProfile();

    // Reuse the cached client only if it belongs to the still-active profile.
    if (this.authClient && this.loadedProfile === profile) {
      try {
        await this.refreshTokenIfNeeded(this.authClient);
        return this.authClient;
      } catch (error) {
        console.error('Cached auth client invalid, creating new one...');
        this.authClient = null;
      }
    } else if (this.authClient && this.loadedProfile !== profile) {
      // Active profile changed under us — drop the stale client.
      this.authClient = null;
    }

    try {
      const tokenPath = this.resolveTokenPath();
      const content = await fs.readFile(tokenPath, 'utf8');
      const tokenData: TokenData = JSON.parse(content);

      const credentialsContent = await fs.readFile(this.CREDENTIALS_PATH, 'utf8');
      const credentials: AuthConfig = JSON.parse(credentialsContent);
      const clientConfig = this.getClientConfig(credentials);

      this.authClient = new OAuth2Client(
        clientConfig.client_id,
        clientConfig.client_secret,
        clientConfig.redirect_uris?.[0]
      );

      this.authClient.setCredentials({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry_date: tokenData.expiry_date
      });

      this.loadedProfile = profile;
      await this.refreshTokenIfNeeded(this.authClient);
      return this.authClient;
    } catch (error) {
      console.error(`No valid token for profile "${profile}", initiating authentication flow...`);
      this.authClient = null;
      return await this.authenticate();
    }
  }

  async authenticate(): Promise<OAuth2Client> {
    try {
      try {
        await fs.access(this.CREDENTIALS_PATH);
      } catch {
        throw new AuthenticationError(
          `Credentials file not found at ${this.CREDENTIALS_PATH}. ` +
          'Please place your Google OAuth credentials in src/auth/credentials.json'
        );
      }

      const client = await authenticate({
        scopes: this.SCOPES,
        keyfilePath: this.CREDENTIALS_PATH,
      });

      if (client.credentials) {
        this.authClient = client as unknown as OAuth2Client;
        this.loadedProfile = this.getActiveProfile();
        await this.saveToken(this.authClient);
        console.error(`Authentication successful! Token saved for profile "${this.loadedProfile}".`);
      }

      return this.authClient || (client as unknown as OAuth2Client);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(`Authentication failed: ${error}`);
    }
  }

  private async refreshTokenIfNeeded(auth: OAuth2Client): Promise<void> {
    try {
      const now = Date.now();
      const expiryDate = auth.credentials.expiry_date;
      const fiveMinutesFromNow = now + (5 * 60 * 1000);

      if (!expiryDate || expiryDate <= fiveMinutesFromNow) {
        if (!auth.credentials.refresh_token) {
          console.error('No refresh token available');
          throw new TokenExpiredError('No refresh token available');
        }

        const { credentials } = await auth.refreshAccessToken();
        auth.setCredentials(credentials);
        await this.updateStoredToken(auth);
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
      this.authClient = null;
      throw new TokenExpiredError('Token refresh failed - please re-authenticate');
    }
  }

  /** Save the current client's token to the ACTIVE profile's token file. */
  private async saveToken(client: OAuth2Client): Promise<void> {
    try {
      const credentialsContent = await fs.readFile(this.CREDENTIALS_PATH, 'utf8');
      const credentials: AuthConfig = JSON.parse(credentialsContent);
      const clientConfig = this.getClientConfig(credentials);

      const tokenData: TokenData = {
        type: 'authorized_user',
        client_id: clientConfig.client_id,
        client_secret: clientConfig.client_secret,
        refresh_token: client.credentials.refresh_token!,
        access_token: client.credentials.access_token || undefined,
        expiry_date: client.credentials.expiry_date || undefined
      };

      await fs.mkdir(this.TOKENS_DIR, { recursive: true });
      const target = this.tokenPathFor(this.getActiveProfile());
      await fs.writeFile(target, JSON.stringify(tokenData, null, 2));
      await fs.chmod(target, 0o600);
    } catch (error) {
      throw new AuthenticationError(`Failed to save token: ${error}`);
    }
  }

  /** Update the stored access token/expiry for the profile the client was loaded from. */
  private async updateStoredToken(auth: OAuth2Client): Promise<void> {
    try {
      // Pin the write to the profile this client was BUILT from, never the
      // currently-active one. If the profile changes between load and refresh,
      // resolveTokenPath() with no argument would put this access_token into a
      // different account's token file, next to a refresh_token it does not match.
      const tokenPath = this.resolveTokenPath(this.loadedProfile ?? undefined);
      const content = await fs.readFile(tokenPath, 'utf8');
      const tokenData: TokenData = JSON.parse(content);

      tokenData.access_token = auth.credentials.access_token || undefined;
      tokenData.expiry_date = auth.credentials.expiry_date || undefined;

      await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2));
    } catch (error) {
      throw new AuthenticationError(`Failed to update stored token: ${error}`);
    }
  }

  /** Revoke + remove ONLY the active profile's token (other profiles untouched). */
  async revokeToken(): Promise<void> {
    try {
      const auth = await this.getAuthClient();
      await auth.revokeCredentials();

      this.authClient = null;
      this.loadedProfile = null;

      const tokenPath = this.resolveTokenPath();
      try {
        await fs.unlink(tokenPath);
        console.error(`Token revoked and removed for profile "${this.getActiveProfile()}".`);
      } catch (error) {
        console.error('Failed to remove token file:', error);
      }
    } catch (error) {
      throw new AuthenticationError(`Failed to revoke token: ${error}`);
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const auth = await this.getAuthClient();
      return !!auth.credentials.access_token;
    } catch {
      return false;
    }
  }
}
