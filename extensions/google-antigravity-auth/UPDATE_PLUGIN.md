# Google Antigravity Auth Plugin - Updated

## Changes Made

Plugin telah disesuaikan dengan **OpenClaw Plugin Documentation** official.

### Files Modified

| File | Changes |
|------|---------|
| `openclaw.plugin.json` | Empty configSchema dengan `additionalProperties: false` |
| `index.ts` | Menggunakan `emptyPluginConfigSchema()` dari SDK |

### Configuration

Rotation strategy sekarang dikonfigurasi via **environment variable**:

```bash
export ANTIGRAVITY_ROTATION_STRATEGY=round-robin
```

**Options:** `round-robin` | `priority` | `least-used` | `failover`

Atau di `~/.openclaw/openclaw.json`:
```json
{
  "env": {
    "ANTIGRAVITY_ROTATION_STRATEGY": "round-robin"
  }
}
```

---

## Deployment Steps

```bash
# 1. Remove old plugin data
rm -rf ~/.openclaw/extensions/google-antigravity-auth

# 2. Re-deploy/rebuild OpenClaw dengan perubahan ini

# 3. Enable plugin
openclaw plugins enable google-antigravity-auth

# 4. Verify
openclaw doctor
openclaw plugins list

# 5. Login
openclaw models auth login --provider google-antigravity --set-default
```

---

## Multi-Account Usage

```bash
# Login multiple accounts
openclaw models auth login --provider google-antigravity  # Account 1
openclaw models auth login --provider google-antigravity  # Account 2

# Accounts stored at:
~/.openclaw/antigravity-accounts.json
```

Plugin will auto-rotate accounts based on configured strategy.
