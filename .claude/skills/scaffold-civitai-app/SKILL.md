---
name: scaffold-civitai-app
description: Scaffold a new app in apps/<name> wired to the shared @civitai/* packages. Cherry-picks only the packages the app imports and wires each one's dependency, bundler transpile entry, env vars, and a server shim. Use when creating a new monorepo app or *.civitai.com spoke (SvelteKit by default; Next.js supported). Defers to docs/packages/new-app-integration.md and each package README as the source of truth.
---

# Scaffold a Civitai App

Stands up a new `apps/<name>` on the shared `@civitai/*` packages, adding **only** the packages the app
actually needs. Each app cherry-picks; there is no base bundle.

**Source of truth** (read these, don't restate them from memory — they may have changed):
- [docs/packages/new-app-integration.md](../../../docs/packages/new-app-integration.md) — the bootstrap + data-layer procedure
- [docs/auth/spoke-integration-guide.md](../../../docs/auth/spoke-integration-guide.md) — auth depth
- `packages/civitai-*/README.md` — per-package reference (exports, env, gotchas)
- **[apps/moderator](../../../apps/moderator)** — the canonical worked example (SvelteKit). Mirror it.

## When to use

A new monorepo app: a moderator/admin tool, a `*.civitai.com` spoke, an internal dashboard. Not for
adding a feature to an existing app.

## Workflow (interactive after gathering)

### 1. Gather inputs

Ask only what can't be inferred:
- **App name** → `apps/<name>`, package name `@civitai/<name>-app`.
- **Framework** → SvelteKit (default, adapter-node) or Next.js. Mirror `apps/moderator` (SvelteKit) or the
  old Next shape.
- **Packages to include** (cherry-pick) — see the recipe table in §3. Infer from the app's purpose, then
  confirm. Default for a gated data app: `@civitai/auth`, `@civitai/db`, `@civitai/db-schema`, `@civitai/brand`.
- **Auth policy** → the `require` predicate (e.g. `(u) => u.isModerator === true`) and what happens to an
  authenticated-but-unauthorized user (403, or redirect to `https://civitai.com`).

### 2. Scaffold the base (framework files)

Copy the shape of `apps/moderator` — read those files and adapt names. Base files (no packages yet):
`package.json` (`"type": "module"`, vite/svelte-kit scripts), `svelte.config.js` (adapter-node),
`vite.config.ts` (process.env shim + empty `ssr.noExternal` to fill in §3), `tsconfig.json`,
`postcss.config.cjs` (`module.exports = {}`), `.gitignore`, `src/app.html`, `src/app.d.ts`,
`src/global.css`, `src/routes/+layout.svelte`, a landing `+page.svelte`.

Key bootstrap rules (full detail in the integration guide §3–4):
- **Transpile**: packages ship raw TS → add every picked package to Vite `ssr.noExternal` (or Next
  `transpilePackages`), **plus workspace peers** (`@civitai/db` ⇒ also `@civitai/db-schema`).
- **process.env shim** (Vite only): `loadEnv(mode, process.cwd(), '')` → `process.env[k] ??= …`, because
  the packages read `process.env` directly and SvelteKit doesn't populate it.

### 3. Add each picked package (the recipe)

For each package the user picked, apply its row: add the **dep(s)**, add to the **transpile list**, add the
**env vars** (to both `.env` and `.env.example`), and create the **shim** under `src/lib/server/`.

| Package | Deps to add | Transpile list adds | Env (→ .env & .env.example) | Shim |
|---|---|---|---|---|
| `@civitai/auth` | `@civitai/auth` | `@civitai/auth` | `AUTH_JWT_ISSUER`, `AUTH_JWKS_URI`, `AUTH_INTERNAL_TOKEN` | `lib/server/auth.ts` (`createSpokeGuard`) + `hooks.server.ts` |
| `@civitai/db` (Kysely) | `@civitai/db`, `@civitai/db-schema` | both | *(none — explicit conn strings)* `DATABASE_URL`, `DATABASE_REPLICA_URL` | `lib/server/db.ts` (`createKyselyClients`) |
| `@civitai/db` (Prisma) | `@civitai/db`, `@civitai/db-schema` | both | `DATABASE_URL`, `DATABASE_REPLICA_URL`, `NOTIFICATION_DB_URL`, `NOTIFICATION_DB_REPLICA_URL` | `lib/server/db.ts` (`createPrismaClients`) |
| `@civitai/redis` | `@civitai/redis` | `@civitai/redis` | `REDIS_URL` **and** `REDIS_SYS_URL` (both!) | `lib/server/redis.ts` (`createRedisClients`) |
| `@civitai/clickhouse` | `@civitai/clickhouse` | `@civitai/clickhouse` | `CLICKHOUSE_HOST`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD` | `lib/server/clickhouse.ts` (`createClickhouseClient`) |
| `@civitai/email` | `@civitai/email` | `@civitai/email` | `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM` (all optional) | `lib/server/email.ts` (re-export `sendEmail`) |
| `@civitai/axiom` | `@civitai/axiom` | `@civitai/axiom` | `AXIOM_TOKEN`, `AXIOM_ORG_ID`, `AXIOM_DATASTREAM` (all optional) | `lib/server/logger.ts` (`createAxiomLogger`) |
| `@civitai/telemetry` | `@civitai/telemetry` | `@civitai/telemetry` | *(none)* | `lib/server/metrics.ts` + a `/metrics` route |
| `@civitai/brand` | `@civitai/brand` | `@civitai/brand` | *(none)* | `routes/favicon.svg/+server.ts` (`buildFaviconSvg`) |
| `@civitai/db-schema` | *(peer of db; rarely alone)* | `@civitai/db-schema` | *(none)* | import `DB` / enums directly |

Shim snippets live in the package READMEs and the integration guide — read and adapt, don't invent.

Do **not** add transitive deps (`pg`, `kysely`, `jose`) — they resolve through the workspace packages.
Add them only if the app imports them directly (e.g. `import { sql } from 'kysely'`).

### 4. Critical per-package gotchas (call these out)

- **Redis: both URLs or neither.** Setting only `REDIS_URL` (e.g. just for the auth session cache) without
  `REDIS_SYS_URL` makes `loadRedisEnv` throw — caught as fail-open, so the cache is *silently* lost.
- **db: pick the right entry.** `@civitai/db/kysely` is env-free and Prisma-free (use for light apps); the
  `@civitai/db` Prisma entry requires the full 4-var DB env set.
- **db SSL**: pass `sslNoVerify: true` to `createKyselyClients` for the cnpg pooler's self-signed cert.
- **auth needs redis only for revocation**: the guard fails open to a hub fetch without redis. Only pull
  `@civitai/redis` into an auth-only app if you want real-time revocation (`isRevoked`) or the cache.

### 5. Verify (always, both commands)

```bash
pnpm install
pnpm --filter @civitai/<name>-app run typecheck
pnpm --filter @civitai/<name>-app run build
```

Both must pass. Then **trim-check** every dependency you're unsure about: remove it, reinstall, re-run
typecheck **and** build — typecheck can pass on transitive types while runtime still needs the dep (or
vice-versa). Report the final dependency list and which packages were wired.

### 6. Hand off

Surface: the package list chosen, env vars the user must fill in `.env` (real secrets come from the main
app's repo-root `.env`), and the run command (`/dev-server` skill). Don't run release/install of secrets
without asking.
