# 🔄 Google Antigravity Auth - Auto-Rotation & Error Handling

## Features Implemented

### 1. Circuit Breaker Pattern
- **Threshold**: 3 consecutive failures = switch account
- **Auto-activation**: Triggers on any failure type
- **Cooldown**: 1 minute default, account marked `isRateLimited`

### 2. HTTP Error Handlers

| Status | Behavior |
|--------|----------|
| **429** | Mark rate limited + switch immediately |
| **401** | Retry 3x, then switch account |
| **403** | Disable account for 1 hour + switch |
| **5xx** | Retry with exponential backoff (1s, 2s, 4s), then switch |
| **2xx** | Report success, reset failure count |

### 3. Rate Limit Cooldown
- `rateLimitedUntil` timestamp per account
- Auto-clear expired rate limits before selecting account
- Configurable cooldown (default: 60 seconds)

### 4. Auto Token Refresh
- Background task runs every **30 minutes**
- Refreshes tokens expiring within **5 minutes**
- Starts automatically after first account login

### 5. Logging
- All rotator actions logged with `[Rotator]` prefix
- Interceptor actions logged with `[Interceptor]` prefix
- Auto-refresh logged with `[AutoRefresh]` prefix

---

## Configuration

```bash
# Rotation strategy
export ANTIGRAVITY_ROTATION_STRATEGY=round-robin  # or: priority, least-used, failover
```

---

## Usage Flow

```
Request → API Call
            ↓
    Response Handler (interceptor)
            ↓
    ┌───────┼───────┬───────┬───────┐
    ▼       ▼       ▼       ▼       ▼
   2xx     429     401     403     5xx
    ↓       ↓       ↓       ↓       ↓
 success  switch  retry   switch  backoff
            ↓    (3x max)    ↓    + retry
       next acct    ↓   disable   (3x max)
                  switch  1 hour     ↓
                                  switch
```

---

## Account Schema

```typescript
interface AntigravityAccount {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;        // Token expiry timestamp
  projectId?: string;
  
  // Rotation metadata
  priority?: number;        // For priority strategy
  lastUsed?: number;        // Last request timestamp
  requestCount?: number;    // Total successful requests
  failureCount?: number;    // Consecutive failures (0-3)
  isRateLimited?: boolean;  // Currently rate limited?
  rateLimitedUntil?: number; // When rate limit expires
  lastRefreshed?: number;   // Last token refresh timestamp
}
```

---

## Accounts Storage

```
~/.openclaw/antigravity-accounts.json
```

File permissions: 600 (read/write owner only)
