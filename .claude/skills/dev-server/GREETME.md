# dev-server: what changed, in one page

_Written 2026-08-24, against the change that added per-worktree app support._

The dev server used to boot one thing: the main Next.js app. It now boots the **moderator** and
**creator-studio** apps too, from whatever worktree you are standing in. This is the short version
for people who have to use it — `SKILL.md` is the long version.

## The commands

```bash
node .claude/skills/dev-server/cli.mjs start                    # main app, this worktree (unchanged)
node .claude/skills/dev-server/cli.mjs start --app moderator    # moderator, this worktree
node .claude/skills/dev-server/cli.mjs logs   --app moderator
node .claude/skills/dev-server/cli.mjs tail   --app moderator   # follows, like tail on a session
node .claude/skills/dev-server/cli.mjs stop   --app moderator
node .claude/skills/dev-server/cli.mjs app                      # what is running, and where
node .claude/skills/dev-server/cli.mjs status                   # full JSON: sessions, apps, hub
```

- `--app <name>` works on `start`, `logs`, `tail`, `stop`, `restart`.
- `app <name> <subcmd>` is the same thing spelled the other way.
- Both default to the current directory's worktree. `app <name> <subcmd> <worktree>` names another.
- Two apps are registered: `moderator` and `creator-studio`. The auth hub keeps its own `auth` verb.

## Five things worth knowing

**Ports are preferred, not fixed.** moderator 5174, creator-studio 5175. A second worktree starting
the same app drifts to the next free port instead of dying on EADDRINUSE, so you can run two
branches of one app side by side. Nothing needs rewriting to follow the drift — neither app's `.env`
carries its own port or base URL.

**🔴 Read the `path` field, not just that it started.** An app serving the wrong checkout answers
200s and looks completely healthy. `path` is the only thing that contradicts you. This is the bug
the change exists to remove — `app <name> start` used to *always* run the primary checkout, silently,
whatever worktree you typed it from.

**⚠️ `.env` falls through, and the base may point at production.** An app reads
`<primary>/apps/<name>/.env` as its base, with `<worktree>/apps/<name>/.env` layered on top if the
worktree has one. Both are gitignored, so a fresh worktree has neither — the base is what lets it
start at all. That base may be a production database. The app now prints its `DATABASE_URL` **host**
on startup and carries it as `dbHost` in `app` / `status` output. Host only, never the credential.
**Read it before you click anything that writes.**

**The main app's `.env` now falls through too.** Previously a worktree `.env` *replaced* the primary
checkout's outright, so a file written to override two keys started the server with no `DATABASE_URL`
and no secrets. Now the primary's is the base and the worktree's overrides it key by key — a worktree
file only needs to restate what it changes.

**Starting an app starts the auth hub**, if it is enabled and not already running. It does **not**
start the main app: the apps reach it over REST, and a cold Next.js compile is not something to
trigger on your behalf. Start it yourself if the page you are looking at needs it.

## What an app is NOT

An app is a `vite dev` process with a log buffer and a port. It is **not** a `DevSession`, so none of
this applies to it:

- no `pnpm install` on a lockfile change
- no `db:generate` on a schema change
- no branch watching
- no prewarm, no probe

Switch branches under a running moderator and nothing reinstalls. Restart it yourself.

## Gone

`storage` and `notifications` were registered and **could never start** — no `vite.config.ts` (their
dev script is `tsx watch src/server.ts`) and no `.env`, so every attempt died at the `.env` precheck
reporting an auth-hub problem. They are deregistered until someone runs them properly. A selftest now
fails if a registered app lacks a `vite.config.ts`, so this cannot come back quietly.

## `wt` knows about apps now

`wt stale` lists a running app as a reason to keep a worktree, and `wt rm` refuses to delete a tree
serving one (`--stop-server` stops it). It also now takes the primary worktree from `git worktree
list` rather than the directory it was invoked from — run through a worktree's own copy of the CLI it
used to offer **the real main checkout** as removable.

## Tests

Standalone scripts, no vitest. Run any of them directly:

```bash
node .claude/skills/dev-server/scripts/env-chain.selftest.mjs      # .env layering + which object is read
node .claude/skills/dev-server/scripts/app-registry.selftest.mjs   # registry, ports, path identity, the lock
node .claude/skills/dev-server/scripts/db-host.selftest.mjs        # the DB host line never emits a credential
node .claude/skills/dev-server/scripts/cli-verbs.selftest.mjs      # every dispatch target in cli.mjs exists
node .claude/skills/dev-server/scripts/branch-watch.selftest.mjs
node .claude/skills/dev-server/scripts/probe.selftest.mjs
```

If you change any of this, mutate it and check the test goes red.

⚠️ **Nothing else reads `cli.mjs`.** `pnpm typecheck` is scoped to `src/`, CI's ESLint filters by
path prefix, and every other selftest imports `daemon.mjs` and friends. `node --check` will not catch
a deleted function whose call site remains — that is a ReferenceError, not a syntax error.
`cli-verbs.selftest.mjs` is the only thing looking at that file. Run it after touching it.

## If something looks wrong

| Symptom | Look at |
|---|---|
| App shows `main` when you are on a branch | the `path` field — wrong checkout |
| App starts, then 500s on a missing `DATABASE_URL` | `primaryCheckout` in `status`; git may have failed and the fall-through has no base |
| Port is not the documented one | another worktree holds it; `app` shows who |
| `EADDRINUSE` on a port nothing lists | an orphaned child. `stop` says so with the port when it sees one |
| Two servers on one worktree | shouldn't happen — path casing is canonicalised. Report it |
