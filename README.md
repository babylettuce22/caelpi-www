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
| `claude-trade.auth.json` | `{"user": "...", "password": "..."}` for `/claude-trade` and `/claude-trade/login`. Optional `bin` and `cwd` point at the trading agent when it is not in `~/claudetrade`. |

## /claude-trade

Two routes, both behind the Basic credentials above and deliberately not the admin session.

`/claude-trade` serves a static dashboard the trading jobs on this Pi rewrite after every run
(`claude-trade/index.html`, git-ignored). `/claude-trade/login` renews the Schwab token, which
dies every 7 days and can only be renewed by a person. The page asks the agent for an
authorization URL (`claudetrade login --begin`), you sign in at Schwab in a new tab, and the
address Schwab redirects to goes back in through `claudetrade login --finish -`. That address
travels on stdin, so the single-use code it carries never reaches the process list, and the
agent checks it against its own remembered state before exchanging anything. The token is
written by the agent and never passes through this server.
