import { AccountManager } from './account-manager.js';
import { AccountRotator } from './rotator.js';
import { AntigravityAccount, RotationStrategy } from './types.js';
import { refreshAccessToken } from './cli-auth.js';

export class AntigravityMultiProvider {
    private manager: AccountManager;
    private rotator: AccountRotator;

    constructor(options: {
        rotationStrategy?: RotationStrategy;
        accountsFile?: string;
    } = {}) {
        this.manager = new AccountManager(options.accountsFile);
        this.rotator = new AccountRotator(this.manager, options.rotationStrategy || 'round-robin');
    }

    async getCredential(): Promise<{ accessToken: string; projectId?: string; email: string } | null> {

        // Simple retry mechanism for rotation if the first one is invalid/expired and refresh fails
        let attempts = 0;
        const maxAttempts = 3;  // Don't spin forever

        while (attempts < maxAttempts) {
            attempts++;
            const account = await this.rotator.getNextAccount();
            if (!account) {
                return null;
            }

            try {
                // Check expiry
                if (account.expiresAt < Date.now()) {
                    // Refresh
                    try {
                        const tokens = await refreshAccessToken(account.refreshToken);
                        await this.manager.updateAccount(account.email, {
                            accessToken: tokens.access,
                            expiresAt: tokens.expires,
                            failureCount: 0
                        });

                        // Update local var
                        account.accessToken = tokens.access;
                        account.expiresAt = tokens.expires;
                    } catch (err) {
                        // Refresh failed
                        await this.rotator.reportFailure(account.email, false); // Not rate limit, but auth failure
                        continue; // Try next account
                    }
                }

                // Return valid credential
                // We don't call reportSuccess here, we should call it after the REQUEST succeeds. 
                // But this provider interface might just be "give me a token".
                // If we can't hook into the request cycle, we might assume success if we give a token.
                // Better: The consumer of this provider should report back.
                // For now, let's treat "getting a token" as a partial success or just neutral.
                // To properly track usage/least-used, we should mark it as "selected".

                // Just return it. The caller is responsible for reporting success/failure if possible, 
                // or we assume it's used. 
                // For 'least-used' strategy, simply returning it counts as usage? 
                // Usually 'usage' means a request was made.

                return {
                    accessToken: account.accessToken,
                    projectId: account.projectId,
                    email: account.email
                };

            } catch (err) {
                await this.rotator.reportFailure(account.email);
            }
        }
        return null;
    }

    /**
     * hooks for external caller to report status
     */
    async reportSuccess(email: string) {
        await this.rotator.reportSuccess(email);
    }

    async reportFailure(email: string, isRateLimit: boolean) {
        await this.rotator.reportFailure(email, isRateLimit);
    }

    async getHealthStatus() {
        const accounts = await this.manager.getAll();
        const strategy = (this.rotator as any).strategy; // Access private property or add getter

        return {
            healthyAccounts: accounts.filter(a => !a.isRateLimited).length,
            totalAccounts: accounts.length,
            currentStrategy: strategy,
            accounts: accounts.map(a => ({
                email: a.email,
                healthy: !a.isRateLimited,
                requests: a.requestCount || 0,
                priority: a.priority
            }))
        };
    }
}
