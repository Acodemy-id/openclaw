import { AntigravityAccount, RotationStrategy } from './types.js';
import { AccountManager } from './account-manager.js';

// Constants
const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 failures = switch account
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute default cooldown
const MAX_401_RETRIES = 3;

export class AccountRotator {
    private manager: AccountManager;
    private strategy: RotationStrategy;
    private currentRoundRobinIndex = 0;
    private logFn: (msg: string) => void = console.log;

    constructor(manager: AccountManager, strategy: RotationStrategy = 'round-robin') {
        this.manager = manager;
        this.strategy = strategy;
    }

    setLogger(fn: (msg: string) => void) {
        this.logFn = fn;
    }

    private log(msg: string) {
        this.logFn(`[Rotator] ${msg}`);
    }

    setStrategy(strategy: RotationStrategy) {
        this.strategy = strategy;
    }

    /**
     * Get next available account based on strategy.
     * Automatically clears expired rate limits before selection.
     */
    async getNextAccount(): Promise<AntigravityAccount | null> {
        // Clear expired rate limits first
        await this.clearExpiredRateLimits();

        const accounts = await this.manager.getAll();
        const available = accounts.filter(a => !a.isRateLimited);

        if (available.length === 0) {
            this.log('No available accounts - all rate limited');
            // Try to find the one with soonest rate limit expiry
            const rateLimited = accounts.filter(a => a.isRateLimited && a.rateLimitedUntil);
            if (rateLimited.length > 0) {
                const soonest = rateLimited.sort((a, b) =>
                    (a.rateLimitedUntil || 0) - (b.rateLimitedUntil || 0)
                )[0];
                const waitMs = (soonest.rateLimitedUntil || 0) - Date.now();
                this.log(`Soonest rate limit expires in ${Math.ceil(waitMs / 1000)}s for ${soonest.email}`);
            }
            return null;
        }

        this.log(`Available accounts: ${available.length}/${accounts.length}`);

        switch (this.strategy) {
            case 'round-robin':
                return this.selectRoundRobin(available);
            case 'priority':
                return this.selectPriority(available);
            case 'least-used':
                return this.selectLeastUsed(available);
            case 'failover':
                return this.selectFailover(available);
            default:
                return this.selectRoundRobin(available);
        }
    }

    /**
     * Clear rate limits that have expired based on rateLimitedUntil timestamp
     */
    async clearExpiredRateLimits(): Promise<number> {
        const accounts = await this.manager.getAll();
        const now = Date.now();
        let cleared = 0;

        for (const account of accounts) {
            if (account.isRateLimited && account.rateLimitedUntil && account.rateLimitedUntil <= now) {
                await this.manager.updateAccount(account.email, {
                    isRateLimited: false,
                    rateLimitedUntil: undefined,
                    failureCount: 0
                });
                this.log(`Rate limit cleared for ${account.email}`);
                cleared++;
            }
        }

        return cleared;
    }

    private selectRoundRobin(accounts: AntigravityAccount[]): AntigravityAccount {
        if (this.currentRoundRobinIndex >= accounts.length) {
            this.currentRoundRobinIndex = 0;
        }
        const account = accounts[this.currentRoundRobinIndex];
        this.currentRoundRobinIndex = (this.currentRoundRobinIndex + 1) % accounts.length;
        this.log(`Round-robin selected: ${account.email}`);
        return account;
    }

    private selectPriority(accounts: AntigravityAccount[]): AntigravityAccount {
        const sorted = accounts.sort((a, b) => (b.priority || 1) - (a.priority || 1));
        this.log(`Priority selected: ${sorted[0].email} (priority=${sorted[0].priority || 1})`);
        return sorted[0];
    }

    private selectLeastUsed(accounts: AntigravityAccount[]): AntigravityAccount {
        const sorted = accounts.sort((a, b) => (a.requestCount || 0) - (b.requestCount || 0));
        this.log(`Least-used selected: ${sorted[0].email} (requests=${sorted[0].requestCount || 0})`);
        return sorted[0];
    }

    private selectFailover(accounts: AntigravityAccount[]): AntigravityAccount {
        this.log(`Failover selected: ${accounts[0].email}`);
        return accounts[0];
    }

    /**
     * Report successful request - resets failure count, increments request count
     */
    async reportSuccess(email: string): Promise<void> {
        const account = await this.manager.getAccount(email);
        if (account) {
            await this.manager.updateAccount(email, {
                requestCount: (account.requestCount || 0) + 1,
                failureCount: 0,
                lastUsed: Date.now(),
                isRateLimited: false,
                rateLimitedUntil: undefined
            });
            this.log(`Success reported for ${email} (total requests: ${(account.requestCount || 0) + 1})`);
        }
    }

    /**
     * Report failure - implements circuit breaker pattern
     * @param email Account email
     * @param isRateLimit If true (429), mark as rate limited with cooldown
     * @param cooldownMs Custom cooldown duration in ms
     * @returns true if circuit breaker tripped (should switch account)
     */
    async reportFailure(email: string, isRateLimit: boolean = false, cooldownMs: number = RATE_LIMIT_COOLDOWN_MS): Promise<boolean> {
        const account = await this.manager.getAccount(email);
        if (!account) return false;

        const newFailureCount = (account.failureCount || 0) + 1;
        const circuitBroken = newFailureCount >= CIRCUIT_BREAKER_THRESHOLD;

        const updates: Partial<AntigravityAccount> = {
            failureCount: newFailureCount,
            lastUsed: Date.now()
        };

        if (isRateLimit || circuitBroken) {
            updates.isRateLimited = true;
            updates.rateLimitedUntil = Date.now() + cooldownMs;
            this.log(`Account ${email} rate limited until ${new Date(updates.rateLimitedUntil).toISOString()}`);
        }

        await this.manager.updateAccount(email, updates);

        if (circuitBroken) {
            this.log(`CIRCUIT BREAKER: ${email} failed ${newFailureCount} times, switching account`);
        } else {
            this.log(`Failure reported for ${email} (count: ${newFailureCount}/${CIRCUIT_BREAKER_THRESHOLD})`);
        }

        return circuitBroken;
    }

    /**
     * Handle HTTP 429 - Rate Limit
     * Marks account as rate limited with cooldown and returns next account
     */
    async handle429(currentEmail: string, retryAfterMs?: number): Promise<AntigravityAccount | null> {
        const cooldown = retryAfterMs || RATE_LIMIT_COOLDOWN_MS;
        await this.reportFailure(currentEmail, true, cooldown);
        this.log(`429 handler: switching from ${currentEmail}`);
        return this.getNextAccount();
    }

    /**
     * Handle HTTP 401 - Unauthorized
     * Implements retry logic with circuit breaker
     * @returns { shouldRetry, newAccount } - shouldRetry means retry with same account (after refresh), 
     *          newAccount means switch to different account
     */
    async handle401(currentEmail: string): Promise<{ shouldRetry: boolean; newAccount: AntigravityAccount | null }> {
        const account = await this.manager.getAccount(currentEmail);
        if (!account) {
            return { shouldRetry: false, newAccount: await this.getNextAccount() };
        }

        const failureCount = (account.failureCount || 0) + 1;

        // Update failure count
        await this.manager.updateAccount(currentEmail, {
            failureCount,
            lastUsed: Date.now()
        });

        if (failureCount < MAX_401_RETRIES) {
            this.log(`401 handler: retry ${failureCount}/${MAX_401_RETRIES} for ${currentEmail}`);
            return { shouldRetry: true, newAccount: null };
        }

        // Max retries exceeded, switch account
        this.log(`401 handler: max retries (${MAX_401_RETRIES}) exceeded for ${currentEmail}, switching`);
        await this.reportFailure(currentEmail, false);
        const newAccount = await this.getNextAccount();
        return { shouldRetry: false, newAccount };
    }

    /**
     * Handle HTTP 403 - Forbidden
     * Marks account as permanently disabled (long cooldown)
     */
    async handle403(currentEmail: string): Promise<AntigravityAccount | null> {
        // 403 = likely permission issue, long cooldown (1 hour)
        const longCooldown = 60 * 60 * 1000;
        await this.manager.updateAccount(currentEmail, {
            isRateLimited: true,
            rateLimitedUntil: Date.now() + longCooldown,
            failureCount: CIRCUIT_BREAKER_THRESHOLD // Force circuit break
        });
        this.log(`403 handler: ${currentEmail} disabled for 1 hour`);
        return this.getNextAccount();
    }

    /**
     * Handle 5xx errors - Server errors, retry with same account
     */
    async handle5xx(currentEmail: string): Promise<{ shouldRetry: boolean; delay: number }> {
        const account = await this.manager.getAccount(currentEmail);
        const failureCount = (account?.failureCount || 0) + 1;

        if (failureCount < CIRCUIT_BREAKER_THRESHOLD) {
            await this.manager.updateAccount(currentEmail, { failureCount });
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, failureCount - 1) * 1000;
            this.log(`5xx handler: retry ${failureCount} with ${delay}ms delay`);
            return { shouldRetry: true, delay };
        }

        await this.reportFailure(currentEmail, false);
        return { shouldRetry: false, delay: 0 };
    }

    /**
     * Get accounts that need token refresh (expiring within threshold)
     */
    async getAccountsNeedingRefresh(thresholdMs: number = 5 * 60 * 1000): Promise<AntigravityAccount[]> {
        const accounts = await this.manager.getAll();
        const now = Date.now();
        return accounts.filter(a =>
            !a.isRateLimited &&
            a.expiresAt &&
            (a.expiresAt - now) < thresholdMs
        );
    }

    /**
     * Get all accounts for batch refresh
     */
    async getAllAccounts(): Promise<AntigravityAccount[]> {
        return this.manager.getAll();
    }

    /**
     * Update account after token refresh
     */
    async updateAccountTokens(email: string, accessToken: string, expiresAt: number): Promise<void> {
        await this.manager.updateAccount(email, {
            accessToken,
            expiresAt,
            lastRefreshed: Date.now(),
            failureCount: 0
        });
        this.log(`Token refreshed for ${email}, expires at ${new Date(expiresAt).toISOString()}`);
    }

    /**
     * Get account by email
     */
    async getAccount(email: string): Promise<AntigravityAccount | undefined> {
        return this.manager.getAccount(email);
    }
}
