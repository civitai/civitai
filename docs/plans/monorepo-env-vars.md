# Monorepo Environment Variables — Setup Plan

**Status:** proposal · **Author:** @ai · **Date:** 2026-06-10 · **Revised:** 2026-06-11 (config-file loading; no launcher / no new dep)

How env vars are sourced across the monorepo so that shared values (`DATABASE_URL`,
`REDIS_URL`, `EMAIL_*`, OAuth creds) live in **one** place while each app keeps its
own app-specific secrets.

---

## TL;DR

- **Packages never read `.env`.** `@civitai/db`, `@civitai/redis`, `@civitai/email`
  only do `schema.safeParse(process.env)`. They consume whatever the *app* already
  put on `process.env`. So "sharing env" is entirely a question of **who populates
  `process.env` for each app process** — and that's each framework's `.env` loader.
- **No framework walks up to the monorepo root by default.** Next.js loads `.env`
  from its own `cwd`; Vite/SvelteKit loads from the app dir. That's why
  `DATABASE_URL` is currently copy-pasted into three files.
- **Plan:** introduce a root `.env.shared` for cross-app values; keep a per-app
  `.env` for app-specific values; each app loads both with **app-local taking
  precedence** over shared. Loading happens in each app's own config file
  (`src/env/server.ts`, `vite.config.ts`, `next.config.ts`) via `dotenv` — no
  launcher, no new dependency. In production nothing reads files — the platform
  injects per-app env.

---

## The two tiers

| Tier | File(s) | Holds | Read by |
|------|---------|-------|---------|
| **Shared** | `/.env.shared` | DB, notification DB, Redis, Email, OAuth provider creds, `NEXTAUTH_SECRET` | every app |
| **App-specific** | `/.env` (main app), `apps/*/​.env` | secrets only that app needs | one app |

### What goes where

**`/.env.shared`** (cross-app — edit once):
```
# Database
DATABASE_URL  DATABASE_REPLICA_URL  DATABASE_SSL / DATABASE_SSL_CA
DATABASE_POOL_MAX  DATABASE_POOL_IDLE_TIMEOUT  DATABASE_CONNECTION_TIMEOUT  DATABASE_IS_PROD
NOTIFICATION_DB_URL  NOTIFICATION_DB_REPLICA_URL
# Cache
REDIS_URL  REDIS_SYS_URL
# Email (SMTP)
EMAIL_HOST  EMAIL_PORT  EMAIL_SECURE  EMAIL_USER  EMAIL_PASS  EMAIL_FROM
# OAuth providers (shared by main app + auth app)
DISCORD_CLIENT_ID/SECRET  GITHUB_CLIENT_ID/SECRET  GOOGLE_CLIENT_ID/SECRET  REDDIT_CLIENT_ID/SECRET
# Shared signing secret
NEXTAUTH_SECRET
```

**`apps/auth/.env`** (auth app only — the central login hub's identity):
```
AUTH_JWT_PRIVATE_KEY  AUTH_JWT_PUBLIC_KEY  AUTH_JWT_KID  AUTH_JWT_ISSUER  AUTH_JWKS_URI
AUTH_SESSION_COOKIE   AUTH_COOKIE_DOMAIN
NEXTAUTH_URL          # the auth app's own origin
```

**`apps/moderator/.env`** (moderator app only): currently nothing it doesn't get
from shared — leave it minimal (pool-tuning overrides only if they must differ).

**`/.env`** (main app only): everything else already in today's root `.env` —
`S3_*`, `PADDLE_*` / payments, `ORCHESTRATOR_*`, `CLICKHOUSE_*`, `MEILI_*`,
`SEARCH_*`, `NEXT_PUBLIC_*`, scanning, webhooks, etc. None of it is needed by the
sub-apps, so it stays out of `.env.shared` (least-privilege: the auth process
never holds payment/S3 keys).

---

## Directory model

```
model-share-monorepo-bootstrap/
│
├── .env.shared              ← TIER 1: cross-app values (DB, Redis, Email, OAuth)   [gitignored]
├── .env.shared.example      ← committed template for the above
│
├── .env                     ← TIER 2: MAIN APP secrets (S3, payments, orchestrator…) [gitignored]
├── .env-example             ← committed (existing)
│
├── apps/
│   ├── auth/                (SvelteKit / Vite)
│   │   ├── .env             ← TIER 2: auth-only (JWT keypair, cookie, issuer)         [gitignored]
│   │   └── .env.example     ← committed
│   │
│   └── moderator/           (Next.js)
│       ├── .env             ← TIER 2: moderator-only (minimal today)                  [gitignored]
│       └── .env.example     ← committed (to add)
│
└── packages/                ← NONE. Packages never read .env — they validate
    ├── civitai-db/             process.env via loadDbEnv() / loadRedisEnv() / etc.
    ├── civitai-redis/
    └── civitai-email/

Legend:  ← shared (load everywhere)   ← app-local (load on top, can override shared)
```

### Load order per app process (dev)

```
                 ┌─────────────────────┐
   /.env.shared ─┤  process.env (base) │
                 └──────────┬──────────┘
                            │  then app-local overrides on top
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                     ▼
   main app             apps/auth            apps/moderator
   + /.env          + apps/auth/.env     + apps/moderator/.env
   (next dev,        (vite dev,           (next dev,
    cwd=root)         cwd=apps/auth)       cwd=apps/moderator)
        │                   │                     │
        ▼                   ▼                     ▼
   process.env         process.env           process.env
        │                   │                     │
        ▼                   ▼                     ▼
   @civitai/db.loadDbEnv()  reads process.env  (same)
```

**Precedence rule:** `app-local` wins over `shared` on any key collision (so an app
can override a shared default). Keep collisions rare — shared keys should normally
live *only* in `.env.shared`.

---

## Loading mechanism

Turbo runs each app's own `dev`/`build` script in that app's directory, so we
control loading inside each script.

### main app (Next.js, runs from repo root)
Already loads root `.env` via [`src/env/server.ts`](../../src/env/server.ts) using
`dotenv.config({ path: [...] })`. **Change:** add `.env.shared` to the front of that
path array. One line, no new dependency.

```ts
dotenv.config({ path: ['.env.shared', '.env.development.local', '.env.local', '.env.development', '.env'], override: false });
```

The sub-apps don't need a launcher. Their config files (`vite.config.ts`,
`next.config.ts`) are plain JS evaluated **before** the framework reads env, so load
the files there with `dotenv`. Load **most-specific first** — `dotenv` never
overrides an already-set key, so this yields precedence
`real shell env > app-local .env > /.env.shared` without any override flag, and
scripts stay vanilla (`vite dev`, `next dev`).

### apps/auth (SvelteKit / Vite)

`$env/dynamic/private` reads `process.env` at runtime (the same path
[`db.ts`](../../apps/auth/src/lib/server/db/db.ts) uses), and we populate it before
SvelteKit boots:

```ts
// apps/auth/vite.config.ts
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '.env') });              // app-local first (wins)
config({ path: resolve(here, '../../.env.shared') }); // shared fills the gaps
```

### apps/moderator (Next.js)

Same idea in `next.config.ts` (also plain JS, evaluated before the server reads env):

```ts
// apps/moderator/next.config.ts
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env') });              // app-local first
config({ path: resolve(process.cwd(), '../../.env.shared') }); // shared fills gaps
```

Next also auto-loads `apps/moderator/.env` on its own, which is harmless (already
set → not overridden).

> **Why not Vite `envDir` or a launcher?** Vite's `envDir` is a *single* directory
> (can't point at root *and* the app dir), and Vite's `loadEnv` only reads
> conventionally-named files — it won't find a custom `.env.shared`. A
> `dotenvx` / `dotenv-cli` launcher works but adds a dependency and shell-quoting for
> the same result. Calling `dotenv` inside the config file sidesteps both limits:
> no new dep, no script noise, cross-platform (matters on Windows).

---

## Production

No `.env` files ship. Each app's deployment injects its env from the platform
(k8s Secret/ConfigMap, Docker env). The dev split mirrors prod nicely:

- a **shared** Secret (the `.env.shared` set) mounted into every app's deployment, plus
- a **per-app** Secret (the app-local set) mounted into just that app.

`$env/dynamic/private` (auth) and Next server runtime both read real `process.env`
at runtime, so production needs no loader changes.

---

## Migration steps

1. **Create `/.env.shared`** — move the Tier-1 keys (table above) out of the current
   root `.env` into it. Leave main-app-only keys in `/.env`.
2. **Create `/.env.shared.example`** — committed template (keys, no secrets).
3. **Trim sub-app `.env` files** — delete the shared keys now coming from
   `.env.shared`; keep only app-specific keys (auth keeps `AUTH_*` + `NEXTAUTH_URL`).
4. **Main app:** add `.env.shared` to the `dotenv.config` path array in
   `src/env/server.ts`.
5. **Sub-apps:** load `.env.shared` from `apps/auth/vite.config.ts` and
   `apps/moderator/next.config.ts` via `dotenv` (snippets above). Scripts stay
   vanilla; no new dependency.
6. **`.gitignore`:** the example files are re-included. Current rules only un-ignore
   `.env-example` / `.env.example`; add `!*.env.example` (or `!.env.shared.example`)
   so the new template is committable.
7. **Verify:** start each app via `/dev-server`, confirm DB/Redis/Email connect, and
   confirm auth still uses its local JWT keypair + cookie name.

---

## Decisions for review

- `@ai:` **Shared file vs. one root `.env` for everything?** This plan keeps a
  dedicated `.env.shared` so the auth process doesn't carry main-app payment/S3
  secrets (least-privilege). The simpler alternative — point every app at one giant
  root `.env` — works but spreads every secret into every process. Recommending the
  split. — `@dev:` ?
- `@ai:` **OAuth creds placement.** Put in `.env.shared` for now (main app + auth
  both use them during coexistence). Once the main app fully delegates login to the
  auth app, these can move to `apps/auth/.env` only. — `@dev:` ?

> **Resolved:** loading mechanism — use plain `dotenv` inside each app's config file
> (no `dotenvx` / `dotenv-cli` launcher, no new dependency). See *Loading mechanism*.
```
