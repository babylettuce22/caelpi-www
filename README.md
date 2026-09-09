# caelpi-ws

## Secrets

Nothing secret is tracked in this repo (it is public, and the Pi resets the checkout from
GitHub every minute). The server reads them from `~/caelpi-config/` on the Pi
(`CAELPI_CONFIG_DIR` overrides the location), all `chmod 600`:

| File | Contents |
|---|---|
| `admin-config.json` | `{"password": "..."}` for `/admin`; read on every login attempt, so changing it needs no restart. No file means no admin login. |
| `spotify.json` | `client_id`, `client_secret`, `redirect_uri`, `refresh_token` (the `/callback` flow rewrites it) |
| `wordnik.json` | `{"api_key": "..."}` |
| `claude-trade.auth.json` | `{"user": "...", "password": "..."}` for `/claude-trade` |
