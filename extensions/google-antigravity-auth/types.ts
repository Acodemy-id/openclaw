export type RotationStrategy = 'round-robin' | 'priority' | 'least-used' | 'failover';

export interface AntigravityAccount {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // timestamp in ms
    projectId?: string;

    // Metadata for rotation strategies
    priority?: number; // Higher is better
    lastUsed?: number; // timestamp in ms
    requestCount?: number; // Total requests made
    failureCount?: number; // Consecutive failures
    isRateLimited?: boolean;
    rateLimitedUntil?: number; // timestamp in ms - when rate limit expires
    lastRefreshed?: number; // timestamp in ms - for auto-refresh tracking
}

export interface AntigravityProviderConfig {
    rotationStrategy: RotationStrategy;
    accountsFile?: string; // Optional override for accounts file path
}

export interface TokenResponse {
    access: string;
    refresh: string;
    expires: number;
    email?: string;
    projectId?: string;
}
