import { AccountManager } from "./account-manager.js";
import { AccountRotator } from "./rotator.js";
import { AntigravityAccount, RotationStrategy } from "./types.js";
import { refreshAccessToken } from "./cli-auth.js";

/**
 * Format account for display
 */
function formatAccount(account: AntigravityAccount, index: number): string {
    const status: string[] = [];

    if (account.isRateLimited) {
        const until = account.rateLimitedUntil
            ? new Date(account.rateLimitedUntil).toLocaleTimeString()
            : 'unknown';
        status.push(`🚫 Rate Limited (until ${until})`);
    } else {
        status.push('✅ Available');
    }

    const expiresIn = Math.round((account.expiresAt - Date.now()) / 1000 / 60);
    const tokenStatus = expiresIn > 0 ? `${expiresIn}m` : '⚠️ EXPIRED';

    return [
        `${index + 1}. ${account.email}`,
        `   Status: ${status.join(', ')}`,
        `   Token expires: ${tokenStatus}`,
        `   Requests: ${account.requestCount || 0} | Failures: ${account.failureCount || 0}`,
        `   Priority: ${account.priority || 1}`,
    ].join('\n');
}

/**
 * Format account list for chat (more concise)
 */
function formatAccountsForChat(accounts: AntigravityAccount[]): string {
    if (accounts.length === 0) {
        return '📭 No accounts configured';
    }

    const lines = accounts.map((acc, i) => {
        const status = acc.isRateLimited ? '🚫' : '✅';
        const expiry = Math.round((acc.expiresAt - Date.now()) / 1000 / 60);
        const expiryStr = expiry > 0 ? `${expiry}m` : '⚠️EXP';
        return `${i + 1}. ${status} ${acc.email} (${expiryStr}, ${acc.requestCount || 0} reqs)`;
    });

    return `📋 **Antigravity Accounts**\n${lines.join('\n')}`;
}

/**
 * Register CLI commands for manual account management
 */
export function registerCliCommands(
    api: any,
    manager: AccountManager,
    rotator: AccountRotator,
    log: (msg: string) => void
) {
    api.registerCli(
        ({ program }: { program: any }) => {
            const antigravity = program
                .command('antigravity')
                .description('Manage Google Antigravity accounts');

            // List accounts
            antigravity
                .command('list')
                .description('List all Antigravity accounts and their status')
                .action(async () => {
                    const accounts = await rotator.getAllAccounts();

                    if (accounts.length === 0) {
                        console.log('📭 No Antigravity accounts configured.');
                        console.log('Run: openclaw models auth login --provider google-antigravity');
                        return;
                    }

                    console.log('\n📋 Antigravity Accounts\n');
                    console.log('─'.repeat(50));

                    for (let i = 0; i < accounts.length; i++) {
                        console.log(formatAccount(accounts[i], i));
                        console.log('');
                    }

                    console.log('─'.repeat(50));
                    console.log(`Total: ${accounts.length} account(s)`);

                    const available = accounts.filter(a => !a.isRateLimited).length;
                    console.log(`Available: ${available} | Rate Limited: ${accounts.length - available}`);
                });

            // Switch account
            antigravity
                .command('switch [email]')
                .description('Force switch to next account or specific email')
                .action(async (email?: string) => {
                    if (email) {
                        // Switch to specific account
                        const account = await rotator.getAccount(email);
                        if (!account) {
                            console.error(`❌ Account not found: ${email}`);
                            process.exit(1);
                        }

                        // Enable the account and mark others as lower priority temporarily
                        await manager.updateAccount(email, {
                            isRateLimited: false,
                            rateLimitedUntil: undefined,
                            failureCount: 0,
                            priority: 999 // Highest priority to force selection
                        });

                        console.log(`✅ Switched to: ${email}`);
                        log(`[Manual] Switched to account: ${email}`);
                    } else {
                        // Switch to next account
                        const current = await rotator.getNextAccount();
                        if (current) {
                            // Mark current as rate limited to force rotation
                            await rotator.reportFailure(current.email, true, 5000); // 5 second cooldown

                            const next = await rotator.getNextAccount();
                            if (next) {
                                console.log(`✅ Switched from ${current.email} to ${next.email}`);
                                log(`[Manual] Rotated from ${current.email} to ${next.email}`);
                            } else {
                                console.log('⚠️ No other accounts available');
                                // Re-enable current
                                await manager.updateAccount(current.email, { isRateLimited: false });
                            }
                        } else {
                            console.log('❌ No accounts available');
                        }
                    }
                });

            // Disable account
            antigravity
                .command('disable <email>')
                .description('Manually disable an account')
                .action(async (email: string) => {
                    const account = await rotator.getAccount(email);
                    if (!account) {
                        console.error(`❌ Account not found: ${email}`);
                        process.exit(1);
                    }

                    // Disable for 24 hours
                    const cooldown = 24 * 60 * 60 * 1000;
                    await manager.updateAccount(email, {
                        isRateLimited: true,
                        rateLimitedUntil: Date.now() + cooldown
                    });

                    console.log(`🚫 Disabled: ${email} (for 24 hours)`);
                    log(`[Manual] Disabled account: ${email}`);
                });

            // Enable account
            antigravity
                .command('enable <email>')
                .description('Re-enable a disabled account')
                .action(async (email: string) => {
                    const account = await rotator.getAccount(email);
                    if (!account) {
                        console.error(`❌ Account not found: ${email}`);
                        process.exit(1);
                    }

                    await manager.updateAccount(email, {
                        isRateLimited: false,
                        rateLimitedUntil: undefined,
                        failureCount: 0
                    });

                    console.log(`✅ Enabled: ${email}`);
                    log(`[Manual] Enabled account: ${email}`);
                });

            // Refresh all tokens
            antigravity
                .command('refresh')
                .description('Force refresh tokens for all accounts')
                .action(async () => {
                    const accounts = await rotator.getAllAccounts();

                    if (accounts.length === 0) {
                        console.log('📭 No accounts to refresh');
                        return;
                    }

                    console.log(`🔄 Refreshing ${accounts.length} account(s)...\n`);

                    let success = 0;
                    let failed = 0;

                    for (const account of accounts) {
                        try {
                            const tokens = await refreshAccessToken(account.refreshToken);
                            await rotator.updateAccountTokens(account.email, tokens.access, tokens.expires);
                            console.log(`  ✅ ${account.email}`);
                            success++;
                        } catch (error: any) {
                            console.log(`  ❌ ${account.email}: ${error.message}`);
                            failed++;
                        }
                    }

                    console.log(`\n✅ Refreshed: ${success} | ❌ Failed: ${failed}`);
                    log(`[Manual] Token refresh completed: ${success} success, ${failed} failed`);
                });
        },
        { commands: ['antigravity'] }
    );
}

/**
 * Register auto-reply (chat) commands for account management
 */
export function registerChatCommands(
    api: any,
    manager: AccountManager,
    rotator: AccountRotator,
    log: (msg: string) => void
) {
    // /ag-list - List accounts
    api.registerCommand({
        name: 'ag-list',
        description: 'List Antigravity accounts',
        acceptsArgs: false,
        requireAuth: true,
        handler: async () => {
            const accounts = await rotator.getAllAccounts();
            return { text: formatAccountsForChat(accounts) };
        }
    });

    // /ag-switch [email] - Switch account
    api.registerCommand({
        name: 'ag-switch',
        description: 'Switch Antigravity account',
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx: any) => {
            const email = ctx.args?.trim();

            if (email) {
                const account = await rotator.getAccount(email);
                if (!account) {
                    return { text: `❌ Account not found: ${email}` };
                }

                await manager.updateAccount(email, {
                    isRateLimited: false,
                    rateLimitedUntil: undefined,
                    failureCount: 0,
                    priority: 999
                });

                log(`[Chat] Switched to account: ${email}`);
                return { text: `✅ Switched to: ${email}` };
            } else {
                const current = await rotator.getNextAccount();
                if (!current) {
                    return { text: '❌ No accounts available' };
                }

                await rotator.reportFailure(current.email, true, 5000);
                const next = await rotator.getNextAccount();

                if (next && next.email !== current.email) {
                    log(`[Chat] Rotated from ${current.email} to ${next.email}`);
                    return { text: `✅ Switched: ${current.email} → ${next.email}` };
                } else {
                    await manager.updateAccount(current.email, { isRateLimited: false });
                    return { text: '⚠️ No other accounts available' };
                }
            }
        }
    });

    // /ag-disable <email> - Disable account
    api.registerCommand({
        name: 'ag-disable',
        description: 'Disable Antigravity account',
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx: any) => {
            const email = ctx.args?.trim();
            if (!email) {
                return { text: '❌ Usage: /ag-disable <email>' };
            }

            const account = await rotator.getAccount(email);
            if (!account) {
                return { text: `❌ Account not found: ${email}` };
            }

            await manager.updateAccount(email, {
                isRateLimited: true,
                rateLimitedUntil: Date.now() + 24 * 60 * 60 * 1000
            });

            log(`[Chat] Disabled account: ${email}`);
            return { text: `🚫 Disabled: ${email} (24h)` };
        }
    });

    // /ag-enable <email> - Enable account
    api.registerCommand({
        name: 'ag-enable',
        description: 'Enable Antigravity account',
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx: any) => {
            const email = ctx.args?.trim();
            if (!email) {
                return { text: '❌ Usage: /ag-enable <email>' };
            }

            const account = await rotator.getAccount(email);
            if (!account) {
                return { text: `❌ Account not found: ${email}` };
            }

            await manager.updateAccount(email, {
                isRateLimited: false,
                rateLimitedUntil: undefined,
                failureCount: 0
            });

            log(`[Chat] Enabled account: ${email}`);
            return { text: `✅ Enabled: ${email}` };
        }
    });

    // /ag-refresh - Refresh all tokens
    api.registerCommand({
        name: 'ag-refresh',
        description: 'Refresh all Antigravity tokens',
        acceptsArgs: false,
        requireAuth: true,
        handler: async () => {
            const accounts = await rotator.getAllAccounts();

            if (accounts.length === 0) {
                return { text: '📭 No accounts to refresh' };
            }

            const results: string[] = [];
            let success = 0;

            for (const account of accounts) {
                try {
                    const tokens = await refreshAccessToken(account.refreshToken);
                    await rotator.updateAccountTokens(account.email, tokens.access, tokens.expires);
                    results.push(`✅ ${account.email}`);
                    success++;
                } catch (error: any) {
                    results.push(`❌ ${account.email}`);
                }
            }

            log(`[Chat] Token refresh: ${success}/${accounts.length} success`);
            return { text: `🔄 **Token Refresh**\n${results.join('\n')}` };
        }
    });
}
