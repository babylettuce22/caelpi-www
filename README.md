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
| `claude-trade.auth.json` | `{"user": "...", "password": "..."}` for `/claude-trade`, `/claude-trade/login` and `/claude-trade/mode`. Optional `bin` and `cwd` point at the trading agent when it is not in `~/claudetrade`. |
| `mining.json` | `{"token": "..."}` for `/mining`: a fine-grained GitHub token limited to the builds repo with **Contents: Read-only**. Optional `"password"` (asked for before the page or any download) and `"repo"`. |

## /claude-trade

Three routes, all behind the Basic credentials above and deliberately not the admin session.

`/claude-trade` serves a static dashboard the trading jobs on this Pi rewrite after every run
(`claude-trade/index.html`, git-ignored). `/claude-trade/login` renews the Schwab token, which
dies every 7 days and can only be renewed by a person. The page asks the agent for an
authorization URL (`claudetrade login --begin`), you sign in at Schwab in a new tab, and the
address Schwab redirects to goes back in through `claudetrade login --finish -`. That address
travels on stdin, so the single-use code it carries never reaches the process list, and the
agent checks it against its own remembered state before exchanging anything. The token is
written by the agent and never passes through this server.

`/claude-trade/mode` changes the agent's autonomy level (report, paper, live_approve,
live_auto) by running `claudetrade set-mode <mode> --json`. The agent keeps every check it makes
at the terminal: a live mode needs Schwab data, a live token and no HALT file, and the
confirmation phrase typed on the page goes in on stdin and must match word for word. Changes
must be POSTed from this site (checked with `Sec-Fetch-Site`, else `Origin`), because the
browser would send the Basic credentials along with a form another site submits. The agent
announces every change in Telegram.

## /mining

An unlisted download page for Another Mining Game test builds; nothing on the site links to it.
The builds are release assets in a private GitHub repo, uploaded by `Tools/publish/publish.py`
in the game project after each Unity build: the newest `build-*` release supplies the Windows and
Mac zips, and the fixed `spoken-chat` release the Windows voice add-on.
`/mining/download/<windows|mac|spoken-chat>` asks GitHub for the asset with the token above and
redirects the browser to GitHub's short-lived signed link, so no file passes through the Pi and
the token never reaches the browser. The release list is cached for a minute.

With `"password"` set in `mining.json`, `/mining` and `/mining-reports` show a password-only sign-in
page (`mining-login.html`, POST `/mining/login`, 10 wrong tries per address per 15 minutes). A right
password sets a 60-day `mining_auth` cookie signed with the password, so restarts keep people signed
in and changing the password signs everyone out. Basic auth with any user name still works for curl.

## /mining-reports

Lists the crash, error and bug reports the game uploads to `/mining-report` (kept in `~/mining-reports`):
bug text, screenshot, machine details, each file in a report's zip, and a delete button per report plus
"Clear reports". Same sign-in as `/mining`, and refused outright when no password is set.

## /thelongcave/discord

A public Discord join card for The Long Cave (`thelongcave-discord.html`), outside the `/mining` password
because the game's itch.io page iframes it. The browser reads the server's Discord widget JSON itself (online
count, avatars, voice channels), so the route only serves the file.

`/thelongcave/discord/join` redirects to the server's Discord invite: `THELONGCAVE_INVITE` in `server.js` (a
never-expiring invite) when set, else the invite in Discord's widget JSON (Discord replaces it on its own; cached
5 minutes). The card's button and the itch banner link here, so a new invite is one line in `server.js`.
`/thelongcave/discord/banner.png` is that banner (`thelongcave-discord-banner.png`, the game's name-board sign
reading "Join the discord!").
