#!/usr/bin/env node
/*
  reauth.cjs — authenticate a Google account/channel as a named PROFILE for the
  YouTube Analytics MCP, so you can keep several accounts and switch instantly.

      node reauth.cjs [profile-name]

  Run it in a terminal where a browser can open. A Google sign-in opens; pick the
  account that MANAGES the target channel (for a Brand Account, choose that channel
  on the picker). It writes src/auth/tokens/<profile>.json, sets it active, records
  the channel in src/auth/profiles.json, and prints the channel it landed on.

  If no profile-name is given, it is derived from the channel title (e.g. "Piano
  Companion" → "piano-companion").

  After this one-time login, switch between saved accounts in the MCP with
  `switch_profile` — no browser needed.

  Note: YouTube Analytics is gated to the channel's owner/manager account. If the
  OAuth consent screen is in "Testing" mode, add the account as a Test User in the
  Google Cloud project first, or sign-in is blocked.
*/
const path = require("path");
const fs = require("fs");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");

const A = path.join(__dirname, "src", "auth");
const CREDS = path.join(A, "credentials.json");
const TOKENS_DIR = path.join(A, "tokens");
const ACTIVE_FILE = path.join(A, "active-profile");
const META_PATH = path.join(A, "profiles.json");
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtubepartner",
];

const slug = s => (s || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

(async () => {
  const creds = JSON.parse(fs.readFileSync(CREDS, "utf8"));
  const cc = creds.installed || creds.web;
  if (!cc) throw new Error('credentials.json has neither "installed" nor "web" client');

  console.log("Opening Google sign-in… pick the account that manages the target channel.");
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDS });
  const t = client.credentials;
  if (!t.refresh_token) throw new Error("No refresh_token returned — remove the app at https://myaccount.google.com/connections and try again.");

  // Which channel did we authenticate?
  const oc = new OAuth2Client(cc.client_id, cc.client_secret);
  oc.setCredentials({ refresh_token: t.refresh_token });
  const me = await google.youtube({ version: "v3", auth: oc }).channels.list({ part: ["snippet"], mine: true });
  const ch = (me.data.items || [])[0];
  const title = ch ? ch.snippet.title : "";
  const channelId = ch ? ch.id : "";

  const profile = slug(process.argv[2]) || slug(title) || "default";

  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  const tokenPath = path.join(TOKENS_DIR, `${profile}.json`);
  fs.writeFileSync(tokenPath, JSON.stringify({
    type: "authorized_user",
    client_id: cc.client_id,
    client_secret: cc.client_secret,
    refresh_token: t.refresh_token,
    access_token: t.access_token || undefined,
    expiry_date: t.expiry_date || undefined,
  }, null, 2));
  fs.chmodSync(tokenPath, 0o600);

  // Make it active + record channel meta.
  fs.writeFileSync(ACTIVE_FILE, profile, "utf8");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(META_PATH, "utf8")); } catch {}
  meta[profile] = { channelId, title };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

  console.log(`\n✅ Saved profile "${profile}" and set it active.`);
  console.log(`   Channel: ${title || "(none)"}${channelId ? " [" + channelId + "]" : ""}`);
  console.log(`\nReconnect the youtube-analytics MCP so it loads the new token, then use switch_profile to hop between accounts.`);
  if (!/piano/i.test(title)) console.log(`\n⚠️  Heads up: that isn't a "Piano Companion" channel — re-run with the right account if needed: node reauth.cjs piano-companion`);
})().catch(e => { console.error("REAUTH FAILED:", e.message); process.exit(1); });
