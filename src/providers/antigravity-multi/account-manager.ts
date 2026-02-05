import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AntigravityAccount } from './types.js';

export class AccountManager {
    private accountsPath: string;
    private accounts: Map<string, AntigravityAccount> = new Map();
    private loaded = false;

    constructor(customPath?: string) {
        this.accountsPath = customPath || path.join(os.homedir(), '.openclaw', 'antigravity-accounts.json');
    }

    async load(): Promise<AntigravityAccount[]> {
        if (this.loaded) {
            return Array.from(this.accounts.values());
        }

        try {
            const data = await fs.readFile(this.accountsPath, 'utf-8');
            const json = JSON.parse(data);
            if (Array.isArray(json)) {
                this.accounts.clear();
                json.forEach((acc: AntigravityAccount) => {
                    if (acc.email) {
                        this.accounts.set(acc.email, acc);
                    }
                });
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to load accounts:', error);
            }
            // If file doesn't exist, start empty
        }

        this.loaded = true;
        return Array.from(this.accounts.values());
    }

    async save(): Promise<void> {
        const dir = path.dirname(this.accountsPath);
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (err) {
            // ignore if exists
        }

        const data = JSON.stringify(Array.from(this.accounts.values()), null, 2);

        // Write with 600 permissions (read/write by owner only)
        await fs.writeFile(this.accountsPath, data, { mode: 0o600 });
    }

    async addAccount(account: AntigravityAccount): Promise<void> {
        await this.load();
        this.accounts.set(account.email, {
            ...account,
            // Initialize stats defaults if new
            priority: account.priority ?? 1,
            requestCount: account.requestCount ?? 0,
            failureCount: account.failureCount ?? 0,
            isRateLimited: false,
        });
        await this.save();
    }

    async removeAccount(email: string): Promise<boolean> {
        await this.load();
        const result = this.accounts.delete(email);
        if (result) {
            await this.save();
        }
        return result;
    }

    async getAccount(email: string): Promise<AntigravityAccount | undefined> {
        await this.load();
        return this.accounts.get(email);
    }

    async updateAccount(email: string, updates: Partial<AntigravityAccount>): Promise<void> {
        await this.load();
        const account = this.accounts.get(email);
        if (account) {
            this.accounts.set(email, { ...account, ...updates });
            await this.save();
        }
    }

    async getAll(): Promise<AntigravityAccount[]> {
        await this.load();
        return Array.from(this.accounts.values());
    }
}
