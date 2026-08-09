import { z } from "zod";
import { ToolConfig, ToolContext } from '../types.js';

export const authTools: ToolConfig[] = [
  {
    name: "check_auth_status",
    description: "Check if the user is authenticated with YouTube",
    category: "authentication",
    schema: z.object({}),
    handler: async (_, { authManager }: ToolContext) => {
      try {
        const isAuthenticated = await authManager.isAuthenticated();
        
        return {
          content: [{
            type: "text",
            text: `Authentication Status: ${isAuthenticated ? 'Authenticated' : 'Not Authenticated'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error checking auth status: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    },
  },
  {
    name: "revoke_auth",
    description: "Revoke YouTube authentication for the ACTIVE profile and remove its stored token (other profiles are untouched)",
    category: "authentication",
    schema: z.object({}),
    handler: async (_, { authManager, clearYouTubeClientCache }: ToolContext) => {
      try {
        const active = authManager.getActiveProfile();
        await authManager.revokeToken();

        // Clear YouTube client cache
        clearYouTubeClientCache();

        return {
          content: [{
            type: "text",
            text: `Authentication revoked for profile "${active}". Re-authenticate (run reauth.cjs for this profile) to use YouTube tools again.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error revoking auth: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    },
  },
  {
    name: "list_profiles",
    description: "List the saved account profiles (each is a Google account/channel authenticated once), marking which is active. Switch between them with switch_profile — no re-login needed.",
    category: "authentication",
    schema: z.object({}),
    handler: async (_, { authManager }: ToolContext) => {
      try {
        const profiles = authManager.listProfiles();
        if (!profiles.length) {
          return { content: [{ type: "text", text: "No profiles yet. Authenticate one with `node reauth.cjs <profile-name>`." }] };
        }
        const seed = authManager.getSeedProfile();
        const lines = profiles.map((p: any) =>
          `${p.active ? "→" : " "} ${p.name}${p.channelTitle ? `  (${p.channelTitle})` : ""}${p.channelId ? `  [${p.channelId}]` : ""}${p.name === seed ? "  (default for new sessions)" : ""}`
        );
        return {
          content: [{
            type: "text",
            text: `Account profiles (→ = active in THIS session):\n${lines.join("\n")}\n\nSwitch with: switch_profile { "profile": "<name>" }\nA switch affects this session only. Add "persist": true to also change the default for new sessions.`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing profiles: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    },
  },
  {
    name: "switch_profile",
    description: "Switch the active account/channel to a saved profile (from list_profiles). All subsequent analytics tools use that channel. The switch applies to THIS session only — it cannot change the channel another parallel session reads. No browser login if the profile is already authenticated.",
    category: "authentication",
    schema: z.object({
      profile: z.string().describe("Profile name to activate (see list_profiles). e.g. 'piano-companion'"),
      persist: z.boolean().optional().describe("Also make this the starting profile of every FUTURE session. Default false — the switch stays local to this session."),
    }),
    handler: async ({ profile, persist }: { profile: string; persist?: boolean }, { authManager, clearYouTubeClientCache, getYouTubeClient }: ToolContext) => {
      try {
        const name = authManager.setActiveProfile(profile, persist === true);
        const scope = persist === true
          ? 'this session, and the default for future sessions'
          : 'this session only';
        clearYouTubeClientCache();

        if (!authManager.hasToken(name)) {
          return {
            content: [{
              type: "text",
              text: `Switched to profile "${name}", but it has no saved token yet. Authenticate it once with:\n  node reauth.cjs ${name}\n(then this profile is ready and switching to it never needs a login again).`
            }]
          };
        }

        // Confirm which channel this profile actually resolves to.
        try {
          const client = await getYouTubeClient();
          const info = await client.getChannelInfo();
          return {
            content: [{
              type: "text",
              text: `Active profile is now "${name}" (${scope}).\nChannel: ${info.snippet.title} [${info.id}]`
            }]
          };
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: `Switched to profile "${name}", but confirming the channel failed: ${e instanceof Error ? e.message : String(e)}. The token may be expired — re-run: node reauth.cjs ${name}`
            }]
          };
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error switching profile: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    },
  },
];
