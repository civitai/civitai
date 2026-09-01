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

## Which node the daemon runs on — and why it is sticky

The daemon is spawned with `process.execPath` (`cli.mjs:71`, `console.mjs:90`), i.e. **whatever node ran
the CLI verb that first started it**. It then passes its own environment down to every `next dev` it
supervises. So the node you happened to have on `PATH` the first time you typed any command above is the
node the whole tree runs on, until someone shuts the daemon down — and nothing records which one that was.

That is not academic. Measured on a dev box: the daemon was running on ambient node **26.7.0**, while
`.nvmrc` pins **24.19.0**, `package.json` declares `engines.node: ">=24.0.0 <25"`, and production is built
on `node:24.19.0-alpine3.24`. It had been started from a shell outside the dev shell, and that shell also
had no `pnpm` at all — which silently disables the daemon's own auto-install path (it shells out to
`pnpm install` / `pnpm run db:generate` when it sees the lockfile or the schema move).

**The fix, whatever your setup: start it from a shell whose `node --version` matches `.nvmrc` and which
has `pnpm` on `PATH`.** `nvm use` at the repo root gives you both.

**On NixOS (optional)** the flake wrapper does that for you — it pins node to the same version `.nvmrc`
names, puts pnpm on `PATH`, and exports the Prisma engine paths NixOS needs:

```bash
nix run .#dev-server -- status
nix run .#dev-server -- start
nix run .#dev-server -- logs <session-id>
```

Every `node .claude/skills/dev-server/cli.mjs …` invocation elsewhere in this document takes the same
subcommands — the wrapper only decides which node runs them, so nothing here depends on having Nix.

Either way, **check what you have got** before trusting a session:

```bash
# the daemon's real interpreter, not the one you assume
readlink -f /proc/$(cat .claude/skills/dev-server/daemon.pid)/exe
```

Changing node means restarting the daemon — `cli.mjs shutdown`, then start it again from the right shell.
A running daemon will not pick up a new `PATH`.

### A second daemon: `DEV_DAEMON_PORT`

The daemon lives on `127.0.0.1:9444`. Set `DEV_DAEMON_PORT` to stand another one beside it:

```bash
DEV_DAEMON_PORT=9555 node .claude/skills/dev-server/cli.mjs status
```

The CLI, the console, `scripts/test-unit-run.mjs` and the daemon itself all resolve the port through
`scripts/daemon-port.mjs`, and a daemon a client spawns inherits that client's environment — so no two
of them can disagree about where it is. Until 2026-08-19 the daemon did not read the variable at all,
and setting it pointed the client at a port nothing was serving.

The variable is only a default for the daemon; an explicit `node scripts/daemon.mjs --port <port>` still
wins. Each daemon owns the shared `daemon.pid`, so the last one started is the one that file names.

## Never curl a dev port — `probe` instead

```bash
node .claude/skills/dev-server/cli.mjs probe /home
```

A dev server that has stopped serving properly does not refuse connections. It accepts and answers
slowly, or accepts and never answers — so an unbounded `curl` sits there until the 300s tool timeout
and returns nothing you can act on. Chaining a few in one shell call is how ten minutes disappear.
A `PreToolUse` hook blocks unbounded requests at dev ports for this reason; `--max-time` is the
escape hatch if you really want curl.

`probe` requests the route twice with a hard budget, reads the session's own log for those two
requests, and returns a verdict with the matching remedy. It always terminates.

```
UPSTREAM-SLOW  http://localhost:3000/home
  UPSTREAM-SLOW — the framework is fine; time is spent in application code (database, tunnel, cache).
  first : 200 in 8.10s  [next.js 30ms | application-code 8.10s]
  repeat: 200 in 8.10s  [next.js 31ms | application-code 8.10s]
  -> Not a cache problem — do NOT purge, it will not help. [...]
```

Exit code is 0 for `ok`/`cold` and 1 for everything else, so it substitutes for a curl in a check.

Two verdicts worth knowing before you meet them. **`stopped-answering`** means the first request was
served and the second was not — the process is up and something inside it has parked, so starting
another session is the wrong move and the remedy says so. And a probe may add
`note: more than one request to this route in the window`: `probe` tags its own request with a
`?__probe=` nonce so it can find its own log line, but a route that already has a query string —
and every `/api/trpc/*` route, whose handlers parse their query — falls back to matching on the
path, where a busy session's traffic is genuinely indistinguishable from ours. The note means the
reading may not be about your request, which is different from the server declining to explain
itself.

### Why timing alone cannot tell you what is wrong

Two different failures produce the **same** shape — a page that takes ~8s, warm and cold alike, with
a 200 and nothing in the log that reads as an error. Health checks keep passing through both, because
`/api/health` is a cheap already-compiled API route and neither failure touches what it does.

Next already separates them on every request line it prints:

```
 GET /home 200 in 8.1s (next.js: 39ms, proxy.ts: 8ms, application-code: 8.1s)
```

| Reading | Meaning | Remedy |
|---|---|---|
| `next.js` dominates on a **repeat** hit | The build cache is not serving; the framework redoes the work every time | `unwedge` — purge and restart |
| `application-code` dominates | The framework is fine; the time is downstream (database, tunnel, cache) | Fix the upstream. **Purging costs 45s and changes nothing** |
| Repeat is fast | Cold compile, working as designed | Nothing |

**Two failures are FAST, and both are checked before any timing rule**, because a verdict of `ok` on
a broken page is worse than no verdict. A stale `node_modules` after a merge or checkout 500s in
milliseconds (`STALE-DEPS` — the fix is `pnpm install`, and purging the build cache installs
nothing); and the settings self-fetch case below renders a degraded page quickly.

**One case defeats the split, and `probe` checks for it first.** `_app` self-fetches
`/api/user/settings` on every SSR render and aborts at `APP_SETTINGS_FETCH_TIMEOUT_MS` (8s default).
That abort is billed to *application-code*, so a server that cannot answer its own API route reads as
"slow database" on the split alone. The greppable marker `[_app] settings bootstrap fetch failed`
outranks the timing, and the verdict is `SELF-FETCH-FAILING`; `probe` then requests that endpoint
directly and tells you which of the two causes you have — a self-fetch aimed at the wrong port
(`NEXTAUTH_URL_INTERNAL` vs the session's port) or an endpoint that genuinely never answers.

The tell that separates it from any slow dependency: **the page time is a constant equal to a
configured timeout**, identical warm and cold. A slow dependency varies; a timeout does not. Measured
2026-08-16 — moving `APP_SETTINGS_FETCH_TIMEOUT_MS` from 8000 to 30000 moved `/home` from 8.1s to
30.1s in lockstep, and purging `.next` did not help at either value.

Worth knowing when you read that verdict: `updateEnvUrlsForPort` returns early on port 3000, so a
primary session uses `NEXTAUTH_URL_INTERNAL` exactly as the `.env` writes it while every secondary
session gets it rewritten to its own port. The value is correct today — this is only why the two
kinds of session can differ, and why the verdict asks you to compare it against the session's port.

This is why "flat 8s means purge `.next`" is wrong as a rule and cost real time as a habit: measured
on this repo on 2026-08-16, a flat 8.1s `/home` was **30ms of framework and 8.1s of application
code** — a purge would have deleted several GB and fixed nothing. Read the split, not the total.

When the split is unavailable (log buffer overran, no session), the verdict is `slow-unclassified`
and it says so rather than guessing.

### `unwedge` — only after a `WEDGED` verdict

```bash
node .claude/skills/dev-server/cli.mjs unwedge <session-id>
```

Stops the session, deletes its build dir, restarts on the same env modes, waits for ready, re-probes,
and prints each timing. It costs a guaranteed ~45s rebuild, so it is not automatic and it does not
guess a session: name the id, because the session you did not name is usually the one someone is
looking at.

Self-tests. Standalone scripts, no vitest — run the ones your change touches, and `cli-verbs`
after any edit to `cli.mjs`:

```bash
node .claude/skills/dev-server/scripts/env-chain.selftest.mjs          # .env layering, both directions
node .claude/skills/dev-server/scripts/app-registry.selftest.mjs       # registry, ports, path identity, the lock
node .claude/skills/dev-server/scripts/db-host.selftest.mjs            # the DB host line never emits a credential
node .claude/skills/dev-server/scripts/cli-verbs.selftest.mjs          # every dispatch target in cli.mjs exists
node .claude/skills/dev-server/scripts/branch-watch.selftest.mjs       # HEAD watching + the restart decision
node .claude/skills/dev-server/scripts/probe.selftest.mjs              # the classifier, pure
node .claude/skills/dev-server/scripts/probe.integration.selftest.mjs  # the real probe() end to end
node .claude/skills/dev-server/scripts/worktree.selftest.mjs           # what `wt stale` / `wt rm` say about a PR and a prune
node .claude/hooks/check-writable.selftest.mjs                         # the hook, both directions
```

The integration one exists because the unit one cannot see the bug that matters most. `runSample`
once dropped `missingModule` on the way to `classify`, so the whole `stale-deps` verdict was dead
code — and every unit case for it passed, because they hand-built the field the shipping code never
produced. **Reintroduce that bug today and the unit test is still green while the integration test
fails.** Anything that adds a new signal belongs in the integration file, not just the unit one.

## CLI Commands

| Command | Description |
|---------|-------------|
| `probe [route]` | Bounded request + verdict (`ok`/`cold`/`wedged`/`stale-deps`/`upstream-slow`/`proxy-slow`/`error-status`/`self-fetch-failing`). Use instead of curl |
| `unwedge <session-id>` | Stop, purge the build dir, restart, wait, re-probe (~45s) |
| `status` | Check daemon status and list all sessions |
| `list` | List all dev sessions |
| `start [worktree] [--app name] [--prod a,b] [--dev a,b]` | Start a dev server (default: the main app, current directory) |
| `logs [session-id] [--app name]` | Get logs for a session, or for an app in this worktree |
| `tail [session-id] [--app name]` | Tail logs continuously |
| `stop <session-id>` \| `stop --app name` | Stop a session or an app |
| `restart <session-id>` \| `restart --app name` | Restart a session or an app |
| `rgb [subcmd]` | RGB proxy control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `app` | List running apps, their worktree, and what is available |
| `app <name> [subcmd] [worktree]` | App control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `auth [subcmd]` | Auth hub control (`status`\|`start`\|`stop`\|`restart`\|`logs`) |
| `test run [worktree]` | Queue a unit-test run; returns position + the command to wait on it |
| `test wait <run-id>` | Block until that run finishes; exits with the run's exit code |
| `test list` / `test show <id>` / `test logs <id>` | Queue state, one run, one run's output |
| `test cancel <id>` | Cancel a queued or running run |
| `test config [n]` | Show or set the concurrency limit (`0` pauses the queue) |
| `shutdown` | Shutdown the daemon |

## Env modes — which services a session talks to

A session layers its `.env` files — the primary checkout's as the base, the worktree's own on top —
and then applies a per-service **overlay** on that. The overlay only restates the keys for the
services it names, so nothing else in the chain moves.

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

`--prod`/`--dev` can only move the groups **your own** `env-modes.local` defines, and that file is
gitignored — a fresh copy of `env-modes.example` defines none, so `--prod all` is a no-op until you
fill it in. Adding a service is an edit to that file, not to the code.

⚠️ **`env-modes.local` does not fall through** the way `.env` now does. It is read from the skill
directory of the daemon that is running (`env-modes.mjs`), so a daemon started from a worktree's own
copy of the CLI finds none and applies no overlay at all. Start the daemon from the primary checkout,
or the groups simply will not exist.

Several services have **no dev counterpart to move to at all** — `env-modes.mjs` lists orchestrator,
payments, s3, clickhouse, notifications, feeds and opensearch in `PROD_ONLY_GROUPS`, and `auth-hub`
in `UNMOVABLE_GROUPS` (it is one shared process reading its own `.env`, so an overlay there would
repoint the app at a hub that is not running). `mode: dev` therefore never means "nothing here is
production".

⚠️ **Apps have no env modes.** `--prod`/`--dev` apply to the main app only; an app runs on its `.env`
chain with no overlay. `start --app <name> --prod db` is refused rather than silently ignored.

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
- **The log window holds the last 2000 lines, and says when it clipped.** A run that emits
  more than that loses its oldest lines, so a late `test wait` or a `test logs` read can be a
  fragment. Both waiters print `WARNING: this log is INCOMPLETE …` naming how many lines went,
  and `logsDropped` is on the run view — a non-zero value means do not quote what you see as
  the whole run. A live waiter that has been streaming from the start is unaffected.
- **The exit code is `exitCodeFor`'s, in both waiters.** `test wait` and `pnpm run test:unit:run`
  read the same rule, so a run killed by a signal reports 1 from either, never a shell 255.

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

Run `node .claude/skills/dev-server/console.mjs` (or `pnpm run dev:daemon`) for a live terminal dashboard.

| Key | Action |
|-----|--------|
| `1` | Filter: errors (error + warn levels) |
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

## Apps

`moderator` and `creator-studio` run through the daemon the same way the main app does — started
from the worktree you are in, logs in the same place, port reserved by the same allocator.

```bash
node .claude/skills/dev-server/cli.mjs start --app moderator    # from the worktree you are in
node .claude/skills/dev-server/cli.mjs app                      # what is running, and where
node .claude/skills/dev-server/cli.mjs app moderator logs
node .claude/skills/dev-server/cli.mjs app moderator restart
node .claude/skills/dev-server/cli.mjs app moderator stop
```

`--app <name>` works on `start`, `logs`, `tail`, `stop` and `restart`, so one gesture covers the
lifecycle;
`app <name> <subcmd>` is the same thing spelled the other way. Both default to the current
directory's worktree, and `app <name> <subcmd> <worktree>` names a different one. Running apps also
appear under `apps` in `status`, beside the main-app sessions.

| App | Preferred port |
|-----|----------------|
| moderator | 5174 |
| creator-studio | 5175 |

**Preferred, not fixed.** The first worktree to start an app gets the number in that table; a second
worktree starting the same app drifts to the next free port instead of dying on EADDRINUSE, so two
branches of the same app can run side by side. Nothing has to be rewritten to follow the drift:
neither app's `.env` carries its own port or base URL. Every app's preferred port is held back from
the drift search, so moderator drifting never displaces creator-studio.

🔴 **Read the `path` field, not just the fact that it started.** An app serving the wrong checkout
answers 200s and looks completely healthy — the only thing that contradicts you is `path`.

**`.env` falls through from the primary checkout.** An app reads `<primary>/apps/<name>/.env` as its
base, with `<worktree>/apps/<name>/.env` layered on top when the worktree has one. Those files are
gitignored, so a fresh worktree has neither — the base is what makes it start at all.

⚠️ **That base may point at a production database**, and the fall-through means a fresh worktree
inherits it without anyone choosing it. The app prints the `DATABASE_URL` **host** (never the
credential) on startup and carries it as `dbHost` in `app` / `status` output — read it before you
click anything that writes.

`storage` and `notifications` are **not** here. They were registered and could never start: no
`vite.config.ts` (their dev script is `tsx watch src/server.ts`) and no `.env`, so every attempt died
at the `.env` precheck reporting an auth-hub problem. Register them properly or not at all.

**Starting an app starts the auth hub** if it is enabled and not already running — an app cannot log
anyone in without it. The **main app is not** started: the apps reach it over REST when they need it,
and a cold Next.js compile is not something to trigger on someone's behalf. Start it yourself if the
page you are looking at needs it.

### They bind `::`, deliberately

The daemon starts every vite sidecar with `--host ::`. Bound to `127.0.0.1` they answered on v4 and
nothing on `[::1]`; Windows resolves `localhost` to `::1` first, so the browser got
connection-refused while curl — which falls back to v4 — reported the server perfectly healthy.
`--host localhost` is **not** the fix either: it resolves to `::1` only, moving the outage onto every
caller that hardcodes `127.0.0.1`. `::` accepts v4-mapped addresses, so `localhost`, `127.0.0.1` and
`[::1]` all answer, and it matches what `next dev` already binds on 3000. Tradeoff: `::` also listens
on LAN interfaces, where the old bind was loopback-only.

### First request is slow

Vite compiles routes on demand in dev. The first hit on a cold app can take **25 seconds or more**
(the auth hub's `/login` is the worst offender); every hit after is a few hundred milliseconds. A
browser sitting on a white page right after startup is usually this, not a hang.

The dashboard shows main-app sessions only. Apps started with `--app` do not appear there — use
`cli.mjs app` or `cli.mjs status`.

## Auth Hub

Authentication was split into a standalone **login hub** (`apps/auth`, SvelteKit on port **5173**). The main app is now a **verify-only spoke**: it validates the hub's `civ-token` via the hub's JWKS and no longer runs next-auth sign-in itself. So a *fresh* login in dev needs the hub running. The daemon boots and manages it as a sidecar, and starting an app (`start --app <name>`) starts it too when `AUTH_HUB_ENABLED` is set and it is not already running.

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
AUTH_HUB_PATH=apps/auth    # relative to the PRIMARY checkout, not the tree the daemon runs from
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

- **A worktree's own `.env` layers on the primary's.** The primary checkout's `.env` is the base of every session; `<worktree>/.env` (or an explicit `--env`) overrides it key by key. So a worktree file needs to restate only what it wants to change, and one that restates nothing is a no-op rather than an outage. The whole chain is logged as `Env: <base> <- <overlay>` at session start and returned as `envPaths` in session status (`envPath` remains the top of the chain).

  Before this they were **not** merged — the worktree file replaced the primary outright, so a two-key override file started the server with no `DATABASE_URL` and no secrets, failing in a way that looked nothing like the edit that caused it.

  **"Primary checkout" is resolved from git, not from where the daemon was launched.** The skill
  directory is committed, so every worktree has its own copy of `daemon.mjs` — a daemon started from
  one would otherwise treat that worktree as the primary and fall back to a `.env` it does not have.
  `git rev-parse --git-common-dir` answers the same from inside any worktree. `wt stale` / `wt rm`
  take the primary from the first entry of `git worktree list`, which git guarantees is the main
  worktree; before that, running them through a worktree's own CLI copy inverted every check and
  offered the real main checkout as removable.
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
