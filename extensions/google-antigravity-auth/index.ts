import { readFileSync } from "node:fs";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { AccountManager } from "./account-manager.js";
import { AccountRotator } from "./rotator.js";
import { RotationStrategy, AntigravityAccount } from "./types.js";
import { CliAuthenticator, exchangeCode, fetchProjectId, fetchUserEmail, refreshAccessToken, AuthParams } from "./cli-auth.js";
import { registerCliCommands, registerChatCommands } from "./commands.js";

const DEFAULT_MODEL = "google-antigravity/claude-opus-4-5-thinking";
const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // Refresh tokens every 30 minutes
const TOKEN_EXPIRY_THRESHOLD_MS = 5 * 60 * 1000; // Refresh if expiring within 5 minutes

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

/**
 * Background task to refresh tokens for all accounts periodically
 */
async function startAutoTokenRefresh(
  rotator: AccountRotator,
  log: (msg: string) => void
): Promise<NodeJS.Timeout> {
  const refreshAllTokens = async () => {
    try {
      const accounts = await rotator.getAccountsNeedingRefresh(TOKEN_EXPIRY_THRESHOLD_MS);

      if (accounts.length === 0) {
        return;
      }

      log(`[AutoRefresh] Refreshing ${accounts.length} account(s) with expiring tokens`);

      for (const account of accounts) {
        try {
          const tokens = await refreshAccessToken(account.refreshToken);
          await rotator.updateAccountTokens(account.email, tokens.access, tokens.expires);
          log(`[AutoRefresh] Refreshed token for ${account.email}`);
        } catch (error: any) {
          log(`[AutoRefresh] Failed to refresh ${account.email}: ${error.message}`);
          await rotator.reportFailure(account.email, false);
        }
      }
    } catch (error: any) {
      log(`[AutoRefresh] Error: ${error.message}`);
    }
  };

  // Run immediately on start
  await refreshAllTokens();

  // Then schedule periodic refresh
  return setInterval(refreshAllTokens, TOKEN_REFRESH_INTERVAL_MS);
}

/**
 * Response interceptor for handling HTTP errors with auto-rotation
 */
function createResponseInterceptor(rotator: AccountRotator, log: (msg: string) => void) {
  return {
    async handleResponse(
      status: number,
      currentEmail: string,
      retryAfterMs?: number
    ): Promise<{
      action: 'continue' | 'retry' | 'switch' | 'fail';
      newCredentials?: AntigravityAccount | null;
      delay?: number;
    }> {
      if (status >= 200 && status < 300) {
        await rotator.reportSuccess(currentEmail);
        return { action: 'continue' };
      }

      if (status === 429) {
        log(`[Interceptor] 429 Rate Limit for ${currentEmail}`);
        const newAccount = await rotator.handle429(currentEmail, retryAfterMs);
        if (newAccount) {
          return { action: 'switch', newCredentials: newAccount };
        }
        return { action: 'fail' };
      }

      if (status === 401) {
        log(`[Interceptor] 401 Unauthorized for ${currentEmail}`);
        const result = await rotator.handle401(currentEmail);
        if (result.shouldRetry) {
          return { action: 'retry', delay: 1000 };
        }
        if (result.newAccount) {
          return { action: 'switch', newCredentials: result.newAccount };
        }
        return { action: 'fail' };
      }

      if (status === 403) {
        log(`[Interceptor] 403 Forbidden for ${currentEmail}`);
        const newAccount = await rotator.handle403(currentEmail);
        if (newAccount) {
          return { action: 'switch', newCredentials: newAccount };
        }
        return { action: 'fail' };
      }

      if (status >= 500 && status < 600) {
        log(`[Interceptor] ${status} Server Error for ${currentEmail}`);
        const result = await rotator.handle5xx(currentEmail);
        if (result.shouldRetry) {
          return { action: 'retry', delay: result.delay };
        }
        const newAccount = await rotator.getNextAccount();
        if (newAccount) {
          return { action: 'switch', newCredentials: newAccount };
        }
        return { action: 'fail' };
      }

      await rotator.reportFailure(currentEmail, false);
      return { action: 'continue' };
    }
  };
}

const antigravityPlugin = {
  id: "google-antigravity-auth",
  name: "Google Antigravity Auth",
  description: "OAuth flow for Google Antigravity (Cloud Code Assist) with Multi-Account Rotation",
  configSchema: emptyPluginConfigSchema(),
  register(api: any) {
    const manager = new AccountManager();
    const strategy = (process.env.ANTIGRAVITY_ROTATION_STRATEGY as RotationStrategy) || 'round-robin';
    const rotator = new AccountRotator(manager, strategy);

    // Set up logging
    const log = (msg: string) => {
      if (api.runtime?.log) {
        api.runtime.log(msg);
      } else {
        console.log(msg);
      }
    };
    rotator.setLogger(log);

    // Register CLI commands (openclaw antigravity ...)
    registerCliCommands(api, manager, rotator, log);

    // Register chat commands (/ag-list, /ag-switch, etc.)
    registerChatCommands(api, manager, rotator, log);

    // Create response interceptor for external use
    const interceptor = createResponseInterceptor(rotator, log);

    // Start auto-refresh background task
    let refreshTimer: NodeJS.Timeout | null = null;

    // Expose utilities via api for external use
    if (api.expose) {
      api.expose('antigravity', {
        rotator,
        interceptor,
        refreshAllTokens: async () => {
          const accounts = await rotator.getAllAccounts();
          const results: { email: string; success: boolean; error?: string }[] = [];

          for (const account of accounts) {
            try {
              const tokens = await refreshAccessToken(account.refreshToken);
              await rotator.updateAccountTokens(account.email, tokens.access, tokens.expires);
              results.push({ email: account.email, success: true });
            } catch (error: any) {
              results.push({ email: account.email, success: false, error: error.message });
            }
          }
          return results;
        }
      });
    }

    api.registerProvider({
      id: "google-antigravity",
      label: "Google Antigravity",
      docsPath: "/providers/models",
      aliases: ["antigravity"],
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "Multi-Account Manager with Auto-Rotation",
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
                  priority: 1,
                  lastRefreshed: Date.now()
                });
                ctx.runtime.log(`Account ${result.email} saved to multi-account manager.`);

                // Start auto-refresh if not already running
                if (!refreshTimer) {
                  refreshTimer = await startAutoTokenRefresh(rotator, log);
                  ctx.runtime.log('[Antigravity] Auto-refresh background task started');
                }
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
                  "Multi-account rotation enabled with circuit breaker (3 failures = switch).",
                  "Auto token refresh runs every 30 minutes.",
                  "CLI: openclaw antigravity list|switch|disable|enable|refresh",
                  "Chat: /ag-list /ag-switch /ag-disable /ag-enable /ag-refresh",
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
        const account = await rotator.getNextAccount();
        if (!account) {
          throw new Error("No available accounts in rotator. All accounts may be rate limited.");
        }

        log(`[RefreshOAuth] Selected account: ${account.email}`);

        if (account.expiresAt < Date.now() + TOKEN_EXPIRY_THRESHOLD_MS) {
          try {
            log(`[RefreshOAuth] Token expiring, refreshing for ${account.email}`);
            const tokens = await refreshAccessToken(account.refreshToken);
            await rotator.updateAccountTokens(account.email, tokens.access, tokens.expires);

            return {
              ...cred,
              access: tokens.access,
              refresh: account.refreshToken,
              expires: tokens.expires,
              email: account.email,
              projectId: account.projectId
            };
          } catch (e: any) {
            log(`[RefreshOAuth] Refresh failed for ${account.email}: ${e.message}`);
            const circuitBroken = await rotator.reportFailure(account.email, false);

            if (circuitBroken) {
              const nextAccount = await rotator.getNextAccount();
              if (nextAccount && nextAccount.email !== account.email) {
                log(`[RefreshOAuth] Circuit broken, switching to ${nextAccount.email}`);
                return {
                  ...cred,
                  access: nextAccount.accessToken,
                  refresh: nextAccount.refreshToken,
                  expires: nextAccount.expiresAt,
                  email: nextAccount.email,
                  projectId: nextAccount.projectId
                };
              }
            }
            throw e;
          }
        }

        await rotator.reportSuccess(account.email);
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
