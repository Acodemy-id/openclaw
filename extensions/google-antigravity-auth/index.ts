import { readFileSync } from "node:fs";
import { z } from "zod";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { AccountManager } from "./account-manager.js";
import { AccountRotator } from "./rotator.js";
import { RotationStrategy } from "./types.js";
import { CliAuthenticator, exchangeCode, fetchProjectId, fetchUserEmail, refreshAccessToken, AuthParams } from "./cli-auth.js";

const DEFAULT_MODEL = "google-antigravity/claude-opus-4-5-thinking";

function isWSL(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

function isWSL2(): boolean {
  if (!isWSL()) {
    return false;
  }
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

async function loginAntigravity(params: {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  note: (message: string, title?: string) => Promise<void>;
  log: (message: string) => void;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
}): Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId: string;
}> {
  const auth = new CliAuthenticator();
  const { authUrl, callbackPromise, closeServer, state, verifier } = await auth.performLogin();

  const needsManual = params.isRemote || isWSL2();

  if (!callbackPromise || needsManual) {
    await params.note(
      [
        "Open the URL in your local browser.",
        "After signing in, copy the full redirect URL and paste it back here.",
        "",
        `Auth URL: ${authUrl}`,
      ].join("\n"),
      "Google Antigravity OAuth"
    );
    params.log("");
    params.log("Copy this URL:");
    params.log(authUrl);
    params.log("");
  }

  if (!needsManual) {
    params.progress.update("Opening Google sign-in…");
    try {
      await params.openUrl(authUrl);
    } catch {
      // ignore
    }
  }

  let code = "";
  let returnedState = "";

  if (callbackPromise && !needsManual) {
    params.progress.update("Waiting for OAuth callback…");
    const callback = await callbackPromise;
    code = callback.searchParams.get("code") ?? "";
    returnedState = callback.searchParams.get("state") ?? "";
    if (closeServer) await closeServer();
  } else {
    params.progress.update("Waiting for redirect URL…");
    const input = await params.prompt("Paste the redirect URL: ");
    try {
      const url = new URL(input.trim());
      code = url.searchParams.get("code") ?? "";
      returnedState = url.searchParams.get("state") ?? "";
    } catch {
      throw new Error("Invalid URL paste");
    }
  }

  if (!code) throw new Error("Missing OAuth code");
  if (returnedState !== state) throw new Error("OAuth state mismatch");

  params.progress.update("Exchanging code for tokens…");
  const tokens = await exchangeCode({ code, verifier });
  const email = await fetchUserEmail(tokens.access);
  const projectId = await fetchProjectId(tokens.access);

  params.progress.stop("Antigravity OAuth complete");
  return { ...tokens, email, projectId };
}


// ... existing imports


const antigravityPlugin = {
  id: "google-antigravity-auth",
  name: "Google Antigravity Auth",
  description: "OAuth flow for Google Antigravity (Cloud Code Assist) with Multi-Account Rotation",
  configSchema: z.object({
    rotationStrategy: z
      .enum(["round-robin", "priority", "least-used", "failover"])
      .optional()
      .default("round-robin"),
  }),
  register(api: any) {
    const manager = new AccountManager();
    const strategy = (api.pluginConfig?.rotationStrategy as RotationStrategy) || 'round-robin';
    const rotator = new AccountRotator(manager, strategy);

    api.registerProvider({
      id: "google-antigravity",
      label: "Google Antigravity",
      docsPath: "/providers/models",
      aliases: ["antigravity"],
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "Multi-Account Manager",
          kind: "oauth",
          run: async (ctx: any) => {
            const spin = ctx.prompter.progress("Starting Antigravity OAuth…");
            try {
              const result = await loginAntigravity({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                note: ctx.prompter.note,
                log: (message) => ctx.runtime.log(message),
                progress: spin,
              });

              // Save to AccountManager
              if (result.email) {
                await manager.addAccount({
                  email: result.email,
                  accessToken: result.access,
                  refreshToken: result.refresh,
                  expiresAt: result.expires,
                  projectId: result.projectId,
                  priority: 1
                });
                ctx.runtime.log(`Account ${result.email} saved to multi-account manager.`);
              }

              const profileId = `google-antigravity:${result.email ?? "default"}`;
              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: "google-antigravity",
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      email: result.email,
                      projectId: result.projectId,
                    },
                  },
                ],
                configPatch: {
                  agents: {
                    defaults: {
                      models: {
                        [DEFAULT_MODEL]: {},
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "Antigravity uses Google Cloud project quotas.",
                  "Multi-account rotation is enabled based on plugin config.",
                ],
              };
            } catch (err) {
              spin.stop("Antigravity OAuth failed");
              throw err;
            }
          },
        },
      ],
      refreshOAuth: async (cred: any) => {
        // INTERCEPT: Rotate account on refresh
        const account = await rotator.getNextAccount();
        if (!account) {
          // Fallback to original refresh if no accounts manager? 
          // Or just fail.
          throw new Error("No available accounts in rotator.");
        }

        if (account.expiresAt < Date.now()) {
          try {
            const tokens = await refreshAccessToken(account.refreshToken);
            await manager.updateAccount(account.email, {
              accessToken: tokens.access,
              expiresAt: tokens.expires,
              failureCount: 0
            });

            // Return refreshed
            return {
              ...cred, // preserve type/provider
              access: tokens.access,
              refresh: account.refreshToken,
              expires: tokens.expires,
              email: account.email,
              projectId: account.projectId
            };
          } catch (e) {
            await rotator.reportFailure(account.email, false);
            throw e;
          }
        }

        // Return valid account credentials (switching identity)
        return {
          ...cred,
          access: account.accessToken,
          refresh: account.refreshToken,
          expires: account.expiresAt,
          email: account.email,
          projectId: account.projectId
        };
      }
    });
  },
};

export default antigravityPlugin;
