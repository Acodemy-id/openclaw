# Quick Fix - Google Antigravity Auth Plugin

## Identifikasi Masalah

Error: `must NOT have additional properties` pada `plugins.entries.google-antigravity-auth.config`

## Root Cause

Versi plugin yang terpasang masih menggunakan schema dengan `additionalProperties: false`.
File schema ada di: `~/.openclaw/extensions/google-antigravity-auth/openclaw.plugin.json`

## Fix Manual

### 1. Edit File Schema Langsung

```bash
# Buka file schema di environment
nano ~/.openclaw/extensions/google-antigravity-auth/openclaw.plugin.json
```

### 2. Ubah `additionalProperties` dari `false` ke `true`

```json
{
  "id": "google-antigravity-auth",
  "providers": ["google-antigravity"],
  "configSchema": {
    "type": "object",
    "additionalProperties": true,    // <-- Ubah dari false ke true
    "properties": {
      "rotationStrategy": {
        "type": "string",
        "enum": ["round-robin", "priority", "least-used", "failover"],
        "default": "round-robin"
      }
    }
  }
}
```

### 3. Restart Gateway

```bash
pkill -f openclaw-gateway
openclaw gateway run
```

### 4. Verifikasi

```bash
openclaw doctor
```

## Alternative: Hapus Config Sementara

Jika ingin login tanpa config dulu:

```bash
# Edit openclaw.json
nano ~/.openclaw/openclaw.json
```

Hapus atau comment bagian config:
```json
{
  "plugins": {
    "entries": {
      "google-antigravity-auth": {
        "enabled": true
        // Hapus bagian "config": {...}
      }
    }
  }
}
```

Lalu jalankan:
```bash
openclaw models auth login --provider google-antigravity --set-default
```

Plugin akan menggunakan default `rotationStrategy: round-robin`.

## Note

Setelah fix, plugin akan support:
- Multi-account login
- Auto-rotation saat rate limit
- Strategy: round-robin, priority, least-used, failover
