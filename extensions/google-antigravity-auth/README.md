# 🔄 Google Antigravity Auth - Complete Documentation

## Features

### 1. Multi-Account Rotation
- 4 strategies: `round-robin`, `priority`, `least-used`, `failover`
- Configure via: `ANTIGRAVITY_ROTATION_STRATEGY=round-robin`

### 2. Auto Error Handling

| Status | Behavior |
|--------|----------|
| **429** | Switch immediately |
| **401** | Retry 3x, then switch |
| **403** | Disable 1 hour, switch |
| **5xx** | Backoff retry, then switch |

### 3. Circuit Breaker
- 3 consecutive failures = switch account
- 1 minute cooldown (auto-clear)

### 4. Auto Token Refresh
- Background task every 30 minutes
- Refreshes tokens expiring within 5 minutes

---

## CLI Commands

```bash
openclaw antigravity list       # List accounts + status
openclaw antigravity switch     # Force rotate to next account
openclaw antigravity switch <email>  # Switch to specific account
openclaw antigravity disable <email> # Disable account (24h)
openclaw antigravity enable <email>  # Re-enable account
openclaw antigravity refresh    # Force refresh all tokens
```

---

## Chat Commands

| Command | Description |
|---------|-------------|
| `/ag-list` | List all accounts |
| `/ag-switch [email]` | Switch account |
| `/ag-disable <email>` | Disable account |
| `/ag-enable <email>` | Enable account |
| `/ag-refresh` | Refresh all tokens |

---

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry, OAuth, provider |
| `commands.ts` | CLI & chat commands |
| `rotator.ts` | Rotation logic & error handlers |
| `account-manager.ts` | Account CRUD |
| `types.ts` | TypeScript interfaces |
| `cli-auth.ts` | OAuth implementation |

---

## Account Storage

```
~/.openclaw/antigravity-accounts.json
```
