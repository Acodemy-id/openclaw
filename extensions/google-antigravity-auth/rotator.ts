import { AntigravityAccount, RotationStrategy } from './types.js';
import { AccountManager } from './account-manager.js';

export class AccountRotator {
    private manager: AccountManager;
    private strategy: RotationStrategy;
    private currentRoundRobinIndex = 0;

    constructor(manager: AccountManager, strategy: RotationStrategy = 'round-robin') {
        this.manager = manager;
        this.strategy = strategy;
    }

    setStrategy(strategy: RotationStrategy) {
        this.strategy = strategy;
    }

    async getNextAccount(): Promise<AntigravityAccount | null> {
        const accounts = await this.manager.getAll();
        const available = accounts.filter(a => !a.isRateLimited);

        if (available.length === 0) {
            // If all are rate limited, maybe try the one with oldest rate limit
            // For now, return null or throw? Let's return null to indicate capacity issue.
            return null;
        }

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

    private selectRoundRobin(accounts: AntigravityAccount[]): AntigravityAccount {
        if (this.currentRoundRobinIndex >= accounts.length) {
            this.currentRoundRobinIndex = 0;
        }
        const account = accounts[this.currentRoundRobinIndex];
        this.currentRoundRobinIndex = (this.currentRoundRobinIndex + 1) % accounts.length;
        return account;
    }

    private selectPriority(accounts: AntigravityAccount[]): AntigravityAccount {
        // Sort by priority desc
        return accounts.sort((a, b) => (b.priority || 1) - (a.priority || 1))[0];
    }

    private selectLeastUsed(accounts: AntigravityAccount[]): AntigravityAccount {
        // Sort by request count asc
        return accounts.sort((a, b) => (a.requestCount || 0) - (b.requestCount || 0))[0];
    }

    private selectFailover(accounts: AntigravityAccount[]): AntigravityAccount {
        // Always pick first available (assuming array order is preserved from load which is insert order usually)
        // Or we could sort by email or a fixed ID to remain consistent
        return accounts[0];
    }

    async reportSuccess(email: string) {
        const account = await this.manager.getAccount(email);
        if (account) {
            await this.manager.updateAccount(email, {
                requestCount: (account.requestCount || 0) + 1,
                failureCount: 0,
                lastUsed: Date.now(),
                isRateLimited: false,
            });
        }
    }

    async reportFailure(email: string, isRateLimit: boolean = false) {
        const account = await this.manager.getAccount(email);
        if (account) {
            const updates: Partial<AntigravityAccount> = {
                failureCount: (account.failureCount || 0) + 1,
            };

            if (isRateLimit) {
                updates.isRateLimited = true;
            }

            await this.manager.updateAccount(email, updates);
        }
    }
}
