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

# Start with a service on production (see Env modes)
node .claude/skills/dev-server/cli.mjs start /path/to/worktree --prod buzz

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
| `start [worktree] [--prod a,b] [--dev a,b]` | Start dev server (default: current directory) |
| `logs [session-id]` | Get logs for a session |
| `tail [session-id]` | Tail logs continuously |
| `stop <session-id>` | Stop a session |
| `restart <session-id>` | Restart a session |
| `rgb [subcmd]` | RGB proxy control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `app` | List the spoke apps and their state |
| `app <name> [subcmd]` | Spoke app control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `auth [subcmd]` | Auth hub control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `test run [worktree]` | Queue a unit-test run; returns position + the command to wait on it |
| `test wait <run-id>` | Block until that run finishes; exits with the run's exit code |
| `test list` / `test show <id>` / `test logs <id>` | Queue state, one run, one run's output |
| `test cancel <id>` | Cancel a queued or running run |
| `test config [n]` | Show or set the concurrency limit (`0` pauses the queue) |
| `shutdown` | Shutdown the daemon |

## Env modes — which services a session talks to

A session picks one `.env` (its worktree's if present, otherwise the project root's) and then
applies a per-service **overlay** on top of it. The overlay only restates the keys for the services
it names, so nothing else in the chosen `.env` moves — the two `.env` files are still never merged.

**No `env-modes.local` means no overlay at all** — not "everything on dev". The file is gitignored,
so it never comes with a checkout: until it exists, every start runs on the base `.env` exactly as
before this feature, and the summary says `(no groups defined — no overlay applied)`.

```bash
# Every defined group on dev. This is what a bare start does.
node .claude/skills/dev-server/cli.mjs start

# Buzz on production, everything else still dev.
node .claude/skills/dev-server/cli.mjs start --prod buzz

# Several groups, the whole lot, and the whole lot with an exception.
node .claude/skills/dev-server/cli.mjs start --prod db,search
node .claude/skills/dev-server/cli.mjs start --prod all
node .claude/skills/dev-server/cli.mjs start --prod all --dev search
```

The groups are whatever `env-modes.local` defines — today `db`, `buzz`, `search`, `signals`,
`redis`. Copy `env-modes.example` to `env-modes.local` (gitignored, holds credentials) and fill it
in; adding a service is an edit to that file, not to the code.

**Defaults.** Every group defaults to `dev`. Move a default in the skill's own `.env` when a dev
service is unreliable:

```
DEVSERVER_PROD_GROUPS=buzz
```

Editing that line does not move a session that is already up — a session pins the defaults it was
created with, so no branch switch or crash restart can quietly relocate it. The cost is that until
those sessions are restarted, a bare `start` against one of them is refused as a mode mismatch,
which is accurate rather than convenient: a bare start would now resolve to something else.

A `--prod` / `--dev` flag beats that, and the flag applies to that start only — a bare start after
a `--prod` start is back on dev, including when it reuses a dead session. Asking for different
modes while a session is already running that worktree is refused rather than silently answered
with the running one; stop it first.

⚠️ **`dev` is not a synonym for safe.** The orchestrator, payments, S3, ClickHouse, the
notifications DB, the feeds proxy and OpenSearch have **no dev counterpart at all** — a session in
full dev mode still talks to production for every one of them. Pressing Generate submits a real job
and spends real Buzz whatever the mode says. That list is printed after every mode summary for
exactly this reason.

**The auth hub does not follow `db`.** It is one process shared by every session and reads its own
`apps/auth/.env`, so a `--prod db` session authenticates against whatever database that file names
and then resolves the resulting user id against production. Dev and prod user ids are unrelated
rows, so expect a 404 — or, worse, to be acting as a different real user. Point `apps/auth/.env` at
the same database by hand before using `--prod db` with a login.

**Changing `search` or `signals` mode on a warm build dir is not fully clean.** Those groups set
`NEXT_PUBLIC_*` values, which Turbopack inlines into client chunks, and the build dir is keyed on
branch rather than on mode. Delete `.next` when you change either of them if the browser matters —
server-side code reads the new value immediately, so this only affects what the client was compiled
against.

**Where to read a running session's modes:** `status` and `list` carry `envModes` and
`envModeSummary`, and the daemon log prints them next to `Env:` at start:

```
Env: C:\Dev\Repos\work\wt-thing\.env
Env modes: buzz=dev db=prod redis=dev search=dev signals=dev | always prod (no dev target): ...
```

## Queued test runs

The unit suite takes every core. One run is fine; five agents each starting one at the same moment
is what flattens the machine. The daemon serialises them.

```bash
# 1. Request a run. Returns immediately, whether it started or queued.
node .claude/skills/dev-server/cli.mjs test run
#    Run t3f9a2 queued at position 2 of 3 (1/1 running).
#    Wait for it in the background: node .claude/skills/dev-server/cli.mjs test wait t3f9a2

# 2. Wait for it — in the background, so you can work meanwhile.
node .claude/skills/dev-server/cli.mjs test wait t3f9a2
```

`test wait` exits with the run's own exit code, so it substitutes for `pnpm run test:unit:run`
wherever that was being checked. Extra args after `--` are passed to vitest, so
`test run . -- path/to/one.test.ts` narrows the run.

**Concurrency defaults to 1**, configurable with `TEST_CONCURRENCY` in the skill's `.env` or at
runtime with `test config <n>`. `0` is legal and means *paused* — nothing starts until it is raised.
A caller that queues behind a paused queue is told so explicitly rather than being handed a position
and left waiting.

Things worth knowing before you rely on it:

- **The daemon owns the run, not you.** An agent that dies mid-wait releases nothing, because it was
  holding nothing. The slot frees when the child process exits.
- **A queued run whose caller stopped polling is dropped** after 10 minutes, so a dead agent cannot
  hold the queue. `test wait` polls every 2s, so a live waiter never trips this.
- **A run that overruns 30 minutes is killed** and reported as `timeout`. If the kill produces no
  exit, the slot is released anyway after a grace period rather than held forever.
- **A daemon restart drops the queue.** `test wait` treats an unknown run id as terminal and exits
  nonzero telling you to re-request — it will not poll forever against a daemon that has forgotten
  you.
- **Position is exact**, not an estimate: it is the index in one ordered list.

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
  "url": "http://localhost:3000",
  "envModes": { "db": "dev", "buzz": "dev", "search": "dev", "signals": "dev", "redis": "dev" },
  "envModeSummary": "buzz=dev db=dev ... | always prod (no dev target): orchestrator, payments, ..."
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
| `s` or `Tab` | Switch to the next session (only shown when more than one is running) |
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

## Spoke Apps

The SvelteKit apps under `apps/` (moderator, creator-studio, storage, notifications) run through the
daemon the same way the auth hub does, so their logs land in the same place and either a human or an
agent can start one and read the output.

```bash
node .claude/skills/dev-server/cli.mjs app                      # list all, with state and URL
node .claude/skills/dev-server/cli.mjs app moderator start
node .claude/skills/dev-server/cli.mjs app moderator logs
node .claude/skills/dev-server/cli.mjs app moderator restart
node .claude/skills/dev-server/cli.mjs app moderator stop
```

| App | Port |
|-----|------|
| moderator | 5174 |
| creator-studio | 5175 |
| storage | 5176 |
| notifications | 5177 |

Ports are fixed rather than auto-assigned, so a redirect between two apps (moderator sends you to the
auth hub to sign in) always lands in the same place. `--strictPort` means a collision fails loudly
instead of silently drifting to the next free port.

Each app needs its own `.env` in its directory — vite loads it, the daemon does not inject it. Start
from that app's `.env.example`.

**Most spoke pages need the auth hub running**, since they redirect to it to sign in:

```bash
node .claude/skills/dev-server/cli.mjs auth start
node .claude/skills/dev-server/cli.mjs app moderator start
```

### They bind to 127.0.0.1, deliberately

The daemon starts every vite sidecar with `--host 127.0.0.1`. Vite's default binds IPv6 loopback
only (`[::1]`), and a Windows hosts file that defines `localhost` explicitly lists `127.0.0.1`
first — so the browser dials an IPv4 socket nothing is listening on and hangs with no error
anywhere. curl papers over it by falling back to `::1` after a couple hundred milliseconds, which
makes it look like a slow server rather than a broken one. Forcing the IPv4 bind removes the whole
class of problem.

### First request is slow

Vite compiles routes on demand in dev. The first hit on a cold app can take **25 seconds or more**
(the auth hub's `/login` is the worst offender); every hit after is a few hundred milliseconds. A
browser sitting on a white page right after startup is usually this, not a hang.

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

## In-place branch switching

Just run `git checkout <branch>`. The daemon handles the rest — no `rm -rf .next`, no manual reinstall.

What happens on a HEAD move:

1. **The dev server keeps running.** It is not killed. Its in-memory module graph survives the checkout, so only what actually changed recompiles.
2. **Debounce** (`BRANCH_SWITCH_DEBOUNCE`, default 3s of HEAD quiet) so a rebase or a fast double-switch settles first.
3. **A restart only if it's unavoidable** — `pnpm-lock.yaml` changed (install, then restart) or `prisma/schema.prisma` changed (`db:generate`, then restart). Those swap `node_modules` and the generated client, which a live process can't pick up. Nothing else forces one.
4. **Re-prewarm** so the recompile lands on the daemon instead of your next click.

### Why not kill it

That was the original design, on the theory that a checkout mutating the tree under Turbopack's watcher is what wedged the server. Measured, that theory was wrong — killing it is simply worse. Same routes, same machine, switching between two branches:

| | `/models` | `/images` |
|---|---|---|
| Cold start after a kill | **42.6s** | 3.1s |
| Left running, first switch | 23.0s | 0.3s |
| Left running, subsequent switches | **7.7-9.2s** | 1.0-1.6s |

The server stayed healthy across every switch. Routes it wasn't asked to rebuild stayed warm the whole time.

`KILL_ON_BRANCH_SWITCH=true` restores the old behaviour if a checkout ever does wedge it.

### Per-branch build dirs (off by default)

`PER_BRANCH_DIST_DIR=true` gives each branch its own `.next/branches/<slug>` via `distDir: process.env.NEXT_DIST_DIR || '.next'` in `next.config.mjs`. It only matters when the server actually restarts, so it is off now that switches keep the process alive — and each dir grows to ~4 GB. Sharing one `.next` also lets unchanged modules stay valid across branches, which per-branch dirs threw away.

### Prewarming

`PREWARM_ROUTES` is compiled in the background once the server reports ready, and again after every branch switch. Cold-compiling the first route costs ~45s because it pulls the whole shared graph; prewarming moves that off you.

**It is empty by default and the skill `.env` is gitignored, so a fresh checkout does no prewarming at all** — set `PREWARM_ROUTES` yourself (see `.env.example`). Prewarm-on-start also needs `HEALTH_CHECK_URL` configured: readiness detected from log patterns alone does not trigger it. Prewarm after a branch switch runs either way.

Measured on a branch with no cache at all:

| | |
|---|---|
| Daemon prewarm (background) | `/` 45.2s, `/models` 3.5s, `/images` 2.9s — done at t+62s |
| Then opening those pages | **0.07-0.14s** |
| Opening a route *not* in the list (`/articles`) | 10.3s |

Add the routes you actually land on. The cost of a longer list is only more background work, but the list is sequential — parallel requests contend for the same compiler and make the first route land later. Set it empty to disable.

**List pages don't warm their detail pages.** `/models` and `/models/[id]/[[...slug]]` are separate routes with separate compiles — a warm `/models` leaves a model page at a ~30s cold hit. So include a specific model id in your list; the id is arbitrary, only the route it resolves to matters. Redirects are followed, so `/models/<id>` reaches the slug route fine.

The skill `.env` is re-read on every session **start**. A keep-alive branch switch does not restart the session, so edits to `PREWARM_ROUTES` reach it only after a switch that forces a restart (lockfile or schema change) or an explicit `restart`.

### Why the cache is so big

It is not per-page. Measured from an empty store on this repo:

| Step | Store size | Response |
|---|---|---|
| boot + `/api/health` | 1 MB | — |
| `/models` (first real page) | **3995 MB** | 49.9s |
| `/images` | 2662 MB | 3.8s |
| `/articles` | 2822 MB | 8.2s |
| `/bounties` | 3762 MB | 28.3s |

The first route compiled drags in the whole shared graph — the pages-router `_app` plus its transitive world — and that costs ~4 GB on its own. Every route after adds only a few hundred MB, and the total **oscillates rather than climbs**: it dropped from 3995 to 2662 MB while more routes were being compiled, because compaction reclaimed superseded segments. The store's `LOG` confirms it: single commits of up to 3.4M keys, with `MERGE`/`Compaction` passes running throughout.

So the working set for this app is roughly **2.5-4 GB per branch**, and it is real data, not a leak. It's large because the graph is large (3.4M cache keys, ~210k files in `node_modules`). Source maps are not the driver — they are 0.3% of a sampled segment.

It earns the space: **45.8s cold vs 4.3s warm** on the same route after a restart. Disabling `turbopackFileSystemCacheForDev` trades a 10x slower restart for disk, which is the wrong trade on a machine with room.

Dirs are evicted LRU on every start against **both** budgets: the `DIST_CACHE_KEEP` most recent (default 4) and `DIST_CACHE_MAX_GB` total (default 40). The size cap does the real work — with a ~4 GB working set per branch, a count cap alone lets four branches reach ~16 GB. The active branch is never evicted; if it alone blows the budget the daemon logs a warning instead.

Knobs live in `.claude/skills/dev-server/.env`, which is gitignored — copy `.env.example`, which documents all of them: `BRANCH_WATCH_ENABLED`, `BRANCH_WATCH_INTERVAL`, `BRANCH_SWITCH_DEBOUNCE`, `KILL_ON_BRANCH_SWITCH`, `AUTO_INSTALL`, `PREWARM_ROUTES`, `PREWARM_TIMEOUT`, `PER_BRANCH_DIST_DIR`, `DIST_CACHE_KEEP`, `DIST_CACHE_MAX_GB`.

## Worktrees

One session per worktree, each on its own port (3000, 3001, …). Start one with:

```bash
node .claude/skills/dev-server/cli.mjs start /path/to/worktree
```

What's already handled:

- **A worktree's own `.env` wins.** A session loads `<worktree>/.env` when one exists, and falls back to the project root's `.env` only when it doesn't — so a worktree with no `.env` still boots healthy. The chosen file is logged as `Env: <path>` at session start and returned as `envPath` in session status.

  **The two are not merged.** Whichever file is chosen supplies every key; nothing is inherited from the other. A worktree `.env` that is a partial copy will therefore be missing whatever it doesn't restate, and different files can point a session at a different database — check the `Env:` line if a session behaves unlike its neighbours.
- **Auth on secondary ports.** `NEXTAUTH_URL`, `NEXTAUTH_URL_INTERNAL`, and `NEXT_PUBLIC_BASE_URL` are rewritten to `http://localhost:<port>`, so logins work on non-3000 sessions instead of bouncing to the primary.
- **Independent branch watching + prewarming** per session.
- **Port allocation sees listeners the daemon does not own.** The picker connects to both loopback
  addresses before it tries to bind, so a port held by a process the daemon has lost track of — a
  session it marked `crashed`, or any other local server on loopback — is skipped rather than handed
  out. Passing an explicit port is no longer a workaround for that. It still cannot see a listener
  bound only to a non-loopback address (`next dev -H <lan-ip>`), which on Windows nothing detects.
- **A session holds its port until it is stopped, whatever its status says.** Status is a report
  about a process the daemon cannot see into: it has read `crashed` for a session that was alive and
  serving, and it reads dead for the moment inside a restart between the kill and the rebind. So the
  reservation follows the session, not the status, and `stop <session-id>` (which removes the
  session) is what frees the port.
- **`start` on a worktree that already has a session takes that session over**, restarting it on its
  own port rather than leaving it stranded and picking a new one. `start` and `restart` are now the
  same thing for an existing worktree; there is no longer a port to lose by picking the wrong one.

  Both check the port is actually free in the moment between the stop and the start, and move the
  session to a new one if something else is holding it — an orphan of its own that outlived a kill,
  or another local server. That check is not optional: `next dev` does **not** fail on an occupied
  port, it warns and quietly moves to another, so a session started onto a held port would report a
  `url` and pass a health check against a server it does not own.

Fresh worktrees still need `pnpm install` (or a `node_modules` junction) and `git submodule update --init event-engine-common`.

### Cache cannot be shared between worktrees

Tested directly — copy a warm 12 GB cache from one worktree into another and Turbopack dies on startup:

```
FATAL: An unexpected Turbopack error occurred.
Error [TurbopackInternalError]: failed to create junction point at ".next\dev\node_modules\..."
Caused by: removal of existing symbolic link or junction point failed: The directory is not empty. (os error 145)
```

Two independent blockers: `.next/dev/node_modules` holds junction points that don't survive a copy, and cache keys embed the absolute project path (~3,000 occurrences of `C:/Dev/Repos/work/model-share` in a single 253 MB segment), so most entries would miss even if it did start.

A single `.next` shared by concurrent sessions is worse — two dev servers writing one LSM store corrupts it.

So a new worktree pays one cold build. The mitigation is prewarming: start the session and let the daemon absorb it in the background rather than waiting on your first click.

## RGB proxy and multiple sessions

`rgb-proxy/index.mjs` registers all three colors — plus the `civitai-dev.cyan` alias — against a hardcoded `http://localhost:3000`. So the color hostnames always reach whichever session holds port 3000; other sessions are reachable on `localhost:<port>` only. The TUI says which case a session is in rather than printing URLs that would silently land on another worktree.

## Windows Defender

Real-time protection scans all ~210k files in `node_modules` plus every build-cache write. Run once from an **elevated** PowerShell:

```powershell
powershell -File .claude\skills\dev-server\scripts\defender-exclusions.ps1
```

## Self-tests

The daemon's trickier invariants are pinned by plain-node self-tests. Run them after touching the
files they cover — they take milliseconds and need no daemon:

```bash
node .claude/skills/dev-server/scripts/branch-watch.selftest.mjs
```

Each case is a shape measured on this repo, and each is mutation-checked: reverting the code it
covers produces a wrong number, not a hang.

## Notes

- The daemon starts automatically when you run CLI commands
- Sessions persist until explicitly stopped or the daemon shuts down
- Logs are kept in memory (up to 2000 lines per session)
