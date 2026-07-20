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
        const lines = profiles.map((p: any) =>
          `${p.active ? "→" : " "} ${p.name}${p.channelTitle ? `  (${p.channelTitle})` : ""}${p.channelId ? `  [${p.channelId}]` : ""}`
        );
        return {
          content: [{
            type: "text",
            text: `Account profiles (→ = active):\n${lines.join("\n")}\n\nSwitch with: switch_profile { "profile": "<name>" }`
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
    description: "Switch the active account/channel to a saved profile (from list_profiles). All subsequent analytics tools use that channel. No browser login if the profile is already authenticated.",
    category: "authentication",
    schema: z.object({
      profile: z.string().describe("Profile name to activate (see list_profiles). e.g. 'piano-companion'"),
    }),
    handler: async ({ profile }: { profile: string }, { authManager, clearYouTubeClientCache, getYouTubeClient }: ToolContext) => {
      try {
        const name = authManager.setActiveProfile(profile);
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
              text: `Active profile is now "${name}".\nChannel: ${info.snippet.title} [${info.id}]`
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
