import { intro, outro, spinner, text, isCancel, confirm, note } from "@clack/prompts";
import { CliAuthenticator, fetchUserEmail, fetchProjectId } from "../providers/antigravity-multi/cli-auth.js";
import { AccountManager } from "../providers/antigravity-multi/account-manager.js";
import { stylePromptTitle } from "../terminal/prompt-style.js"; // Assumption: path exists based on github-copilot-auth.ts
// If prompt-style doesn't exist at that path, I'll remove it or adjust.
// github-copilot-auth.ts imported it from "../terminal/prompt-style.js", which corresponds to src/terminal/prompt-style.js.
// My file is in src/cli/commands/antigravity-login.ts.
// path relative to src/cli/commands is ../../terminal/prompt-style.
// wait, src/cli/commands/antigravity-login.ts -> ../../ = src/
// src/terminal/prompt-style.js is correct.

export async function antigravityLoginCommand() {
    intro("Google Antigravity Login");

    const manager = new AccountManager();
    const auth = new CliAuthenticator();

    let addAnother = true;

    while (addAnother) {
        const existingAccounts = await manager.getAll();
        const count = existingAccounts.length + 1;

        note(`Setting up Account #${count}`, "Multi-Account Setup");

        const spin = spinner();
        spin.start("Preparing OAuth flow...");

        try {
            const { authUrl, verifier, callbackPromise, closeServer } = await auth.performLogin();
            spin.stop("Ready for login");

            if (callbackPromise) {
                // Automatic flow
                note(
                    [`Visit this URL to login:`, `${authUrl}`].join("\n"),
                    "Action Required"
                );

                spin.start("Waiting for callback...");
                try {
                    const url = await callbackPromise;
                    const code = url.searchParams.get("code");
                    if (!code) throw new Error("No code in callback");

                    spin.message("Exchanging code for tokens...");
                    const { exchangeCode } = await import("../providers/antigravity-multi/cli-auth.js");
                    const tokens = await exchangeCode({ code, verifier });

                    spin.message("Fetching user info...");
                    const email = await fetchUserEmail(tokens.access);
                    const projectId = await fetchProjectId(tokens.access);

                    if (!email) throw new Error("Could not fetch email");

                    await manager.addAccount({
                        email,
                        accessToken: tokens.access,
                        refreshToken: tokens.refresh,
                        expiresAt: tokens.expires,
                        projectId
                    });

                    spin.stop(`✅ Account ${email} added!`);

                } catch (err: any) {
                    spin.stop(`❌ Login failed: ${err.message}`);
                } finally {
                    // ensure server closed
                    if (closeServer) await closeServer();
                }

            } else {
                // Manual flow
                note(
                    [
                        "Open this URL in your browser:",
                        authUrl,
                        "",
                        "After authorization, you will be redirected to localhost.",
                        "Copy the CODE from the URL (or the whole URL) and paste it below."
                    ].join("\n"),
                    "Manual Auth"
                );

                const codeInput = await text({
                    message: "Paste authorization code:",
                    placeholder: "4/0A...",
                    validate: (val) => (!val || val.length < 5) ? "Code seems too short" : undefined
                });

                if (isCancel(codeInput)) {
                    outro("Cancelled");
                    return;
                }

                spin.start("Exchanging code...");
                try {
                    // Extract code if url paste
                    let code = codeInput.toString().trim();
                    if (code.includes('code=')) {
                        try {
                            const u = new URL(code);
                            code = u.searchParams.get('code') || code;
                        } catch { }
                    }

                    const { exchangeCode } = await import("../providers/antigravity-multi/cli-auth.js");
                    const tokens = await exchangeCode({ code, verifier });

                    const email = await fetchUserEmail(tokens.access);
                    const projectId = await fetchProjectId(tokens.access);

                    if (!email) throw new Error("Could not fetch email");

                    await manager.addAccount({
                        email,
                        accessToken: tokens.access,
                        refreshToken: tokens.refresh,
                        expiresAt: tokens.expires,
                        projectId
                    });

                    spin.stop(`✅ Account ${email} added!`);
                } catch (err: any) {
                    spin.stop(`❌ Error: ${err.message}`);
                }
            }

        } catch (err: any) {
            spin.stop(`Failed: ${err.message}`);
        }

        const cont = await confirm({
            message: "Add another account?",
            initialValue: false
        });

        if (isCancel(cont) || !cont) {
            addAnother = false;
        }
    }

    outro("Antigravity Login Flow Completed");
}
