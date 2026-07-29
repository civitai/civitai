---
name: dev-server
description: Manage Next.js dev servers across worktrees. Start, stop, and read logs from dev servers. Agents can access logs from any running session, regardless of who started it.
---

# Dev Server Skill

Centralized management of Next.js dev servers across multiple git worktrees. The daemon handles port allocation, environment variable injection, and log aggregation so that any agent can access dev server logs regardless of who started the server.

## Quick Start

```bash
# Check what's running
node .claude/skills/dev-server/cli.mjs status

# Start a dev server for current worktree
node .claude/skills/dev-server/cli.mjs start

# Start for a specific worktree
node .claude/skills/dev-server/cli.mjs start /path/to/worktree

# View logs
node .claude/skills/dev-server/cli.mjs logs <session-id>

# Stop a session
node .claude/skills/dev-server/cli.mjs stop <session-id>
```

**Checking if server is ready:** After starting, poll the session status to check `ready: true`. The daemon marks sessions ready either via configured health check endpoint or by detecting "Ready" patterns in logs.

## CLI Commands

| Command | Description |
|---------|-------------|
| `status` | Check daemon status and list all sessions |
| `list` | List all dev sessions |
| `start [worktree]` | Start dev server (default: current directory) |
| `logs [session-id]` | Get logs for a session |
| `tail [session-id]` | Tail logs continuously |
| `stop <session-id>` | Stop a session |
| `restart <session-id>` | Restart a session |
| `rgb [subcmd]` | RGB proxy control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `auth [subcmd]` | Auth hub control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `shutdown` | Shutdown the daemon |

## Session Object

Each session includes:

```json
{
  "id": "a1b2c3d4",
  "worktree": "/path/to/worktree",
  "branch": "feature/my-feature",
  "port": 3000,
  "status": "running",
  "ready": true,
  "readyAt": "2024-01-15T10:30:02.000Z",
  "startedAt": "2024-01-15T10:30:00.000Z",
  "url": "http://localhost:3000"
}
```

Status values: `starting`, `running`, `stopped`, `crashed`, `error`

## Log Entries

```json
{
  "index": 42,
  "timestamp": "2024-01-15T10:30:05.123Z",
  "level": "stdout",
  "message": "Ready on http://localhost:3000"
}
```

Log levels: `stdout`, `stderr`, `error`, `warn`, `info`

## Dashboard TUI

Run `node .claude/skills/dev-server/console.mjs` (or `npm run dev:daemon`) for a live terminal dashboard.

| Key | Action |
|-----|--------|
| `1` | Filter: errors (error + warn levels) |
| `2` | Filter: bitdex |
| `3` | Filter: trpc |
| `4` | Filter: api |
| `5` | Filter: prisma |
| `6` | Filter: stdout only |
| `7` | Filter: stderr only |
| `8` | Filter: info (daemon messages) |
| `/` or `f` | Free-text search (type query, Enter to apply) |
| `a` | Show all logs (clear filter) |
| `r` | Restart session |
| `c` | Clear log buffer |
| `x` | Stop session + exit |
| `R` | Toggle RGB proxy (start/stop) |
| `A` | Toggle auth hub (start/stop) |
| `q` | Quit dashboard (server keeps running) |
| `K` | Kill daemon + quit |

Filters toggle on/off. Active filter is highlighted in the footer bar. Search highlights matching text in red.

## RGB Proxy

The daemon can optionally manage the `rgb-proxy` reverse proxy (serves `civitai-dev.{red,green,blue}` against the local dev server).

### Configuration

Edit `.claude/skills/dev-server/.env`:

```env
RGB_PROXY_ENABLED=true            # auto-start proxy when daemon boots
RGB_PROXY_PATH=../rgb-proxy       # path relative to project root
```

Also ensure the main `.env` has `NEXTAUTH_URL=https://civitai-dev.blue` + `SERVER_DOMAIN_*` and hosts file maps the three domains to `127.0.0.1`. See `.claude/skills/rgb-proxy/SKILL.md` for first-time setup.

### Control

```bash
# Start / stop / restart / status / logs via CLI
node .claude/skills/dev-server/cli.mjs rgb start
node .claude/skills/dev-server/cli.mjs rgb status

# Or via pnpm scripts
pnpm dev:rgb          # start proxy (daemon boots if not already running)
pnpm dev:rgb:stop
pnpm dev:rgb:status
```

In the dashboard TUI, press `R` to toggle the proxy.

### Admin / sudo requirement

Redbird binds ports 80 and 443. On Windows the daemon must be launched from an elevated terminal; on macOS/Linux start it with `sudo`. If it fails the daemon surfaces `lastError` via `/rgb` status and in RGB proxy logs.

## Auth Hub

Authentication was split into a standalone **login hub** (`apps/auth`, SvelteKit on port **5173**). The main app is now a **verify-only spoke**: it validates the hub's `civ-token` via the hub's JWKS and no longer runs next-auth sign-in itself. So a *fresh* login in dev needs the hub running. The daemon boots and manages it as a sidecar, same as the RGB proxy.

### Control

```bash
node .claude/skills/dev-server/cli.mjs auth status    # status + JWKS url + lastError
node .claude/skills/dev-server/cli.mjs auth start
node .claude/skills/dev-server/cli.mjs auth restart
node .claude/skills/dev-server/cli.mjs auth logs
```

In the dashboard TUI press `A` to toggle it; the session line shows `AUTH: ready`.

### Configuration

`.claude/skills/dev-server/.env`:

```env
AUTH_HUB_ENABLED=true      # auto-start the hub when the daemon boots
AUTH_HUB_PATH=apps/auth    # path relative to project root
AUTH_HUB_PORT=5173         # hub dev port (matches AUTH_JWT_ISSUER)
```

### One-time env setup

The hub reads its **own** `apps/auth/.env` (Vite loads it — the daemon does not inject). It's already been generated for local dev, reusing the main app's dev DB / redis / secret / provider creds, with a fresh EC P-256 (ES256) signing keypair. Two files matter:

- `apps/auth/.env` — hub signing keypair (`AUTH_JWT_PRIVATE_KEY`/`_PUBLIC_KEY`, PKCS8/SPKI), `AUTH_JWT_ISSUER=http://localhost:5173`, shared `NEXTAUTH_SECRET` + `AUTH_INTERNAL_TOKEN`, DB/redis, providers, email.
- root `.env` — spoke side: `AUTH_JWT_ISSUER` + `AUTH_JWKS_URI` (→ `localhost:5173`) + a matching `AUTH_INTERNAL_TOKEN`.

To regenerate the keypair: `openssl ecparam -genkey -name prime256v1 -noout -out sec1.pem && openssl pkcs8 -topk8 -nocrypt -in sec1.pem -out priv.pem && openssl ec -in sec1.pem -pubout -out pub.pem` (private must be **PKCS8** — `BEGIN PRIVATE KEY`, not SEC1 — for jose's `importPKCS8`).

### RGB proxy mode

The hub works behind the RGB proxy too. When you browse dev at `https://civitai-dev.{red,green,blue}` (instead of `localhost:3000`), those are **distinct registrable domains, not loopback**, so the hub would reject first-party login from them unless they're trusted. The hub trusts them via `AUTH_DEV_TRUST_HOSTS` in `apps/auth/.env` (dev-only; already set to the color domains + `civitai-dev.cyan`, mirroring the main app's `SERVER_DOMAIN_*`). The main app still points at the hub via `AUTH_JWT_ISSUER=http://localhost:5173` regardless of which color you browse — each color mints its **own** `civ-token` on its own domain via the first-party OAuth flow. If you add a new color/alias, add its host to `AUTH_DEV_TRUST_HOSTS` and restart the hub (`cli.mjs auth restart`). Ignored entirely in prod.

### Logging in

- **Email magic-link** works out of the box (`EMAIL_*` are set) — no external console changes needed.
- **Social providers** (GitHub/Google/Discord/Reddit) additionally require the provider console to allow the hub redirect URI `http://localhost:5173/login/<provider>/callback`. Until that's added they fail with `redirect_uri_mismatch`.
- Any **legacy** `civitai-token` cookie already in your browser still resolves without the hub (verify-only decode) and upgrades to a `civ-token` on next request once the hub is up.

## Notes

- The daemon starts automatically when you run CLI commands
- Sessions persist until explicitly stopped or the daemon shuts down
- Logs are kept in memory (up to 2000 lines per session)
