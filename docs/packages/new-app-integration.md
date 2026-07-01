# Adding a New App on the Shared `@civitai/*` Packages

How to stand up a new app in this monorepo (`apps/<name>`) and wire it to the shared packages. The
**auth** side is covered in depth by [docs/auth/spoke-integration-guide.md](../auth/spoke-integration-guide.md);
this guide is the **app-bootstrap + data-layer** companion — the cross-cutting wiring that bit us building
the moderator app. Per-package reference lives in each `packages/civitai-*/README.md`.

> Worked example throughout: **[apps/moderator](../../apps/moderator)** (SvelteKit). The auth hub
> **[apps/auth](../../apps/auth)** is a second SvelteKit example.

## 1. The cherry-pick model

An app declares **only the packages it imports**. There's no "base bundle." The dependency graph and env
requirements are entirely a function of which packages you pick. Pull `@civitai/auth` to gate the app,
`@civitai/db` for data, `@civitai/redis`/`@civitai/clickhouse`/`@civitai/email` as features demand —
nothing more. Transitive deps (`pg`, `kysely`, `jose`, `@civitai/redis` via auth) are **not** declared by
the app unless it imports them directly.

## 2. Scaffold (SvelteKit shape)

```
apps/<name>/
  package.json            # "type": "module"; vite/svelte-kit scripts
  svelte.config.js        # @sveltejs/adapter-node
  vite.config.ts          # process.env shim + ssr.noExternal (see §4)
  tsconfig.json           # extends ./.svelte-kit/tsconfig.json
  postcss.config.cjs      # empty {} — stops PostCSS walking up to the root Next/Tailwind config
  .gitignore              # node_modules, /.svelte-kit, /build, .env*
  .env.example            # documented template (committed)
  .env                    # real values, gitignored
  src/
    app.html  app.d.ts  global.css
    hooks.server.ts       # auth adapter (see §5)
    lib/server/           # db.ts, auth.ts, redis.ts, … (one tiny shim per package used)
    routes/
```

The repo's `pnpm-workspace.yaml` already globs `apps/*`, so a new folder is picked up by `pnpm install`.

## 3. The transpile requirement (every package)

The `@civitai/*` packages ship **raw TypeScript** (`main: ./src/index.ts`), so the consumer's bundler must
transpile them — this is the single most common bootstrap mistake.

- **Vite / SvelteKit** — `vite.config.ts`:
  ```ts
  ssr: { noExternal: ['@civitai/auth', '@civitai/db', '@civitai/db-schema', /* …only what you import */ ] }
  ```
- **Next.js** — `next.config.ts`:
  ```ts
  transpilePackages: ['@civitai/db', '@civitai/db-schema', /* … */]
  ```

List **only the packages you import** (plus their workspace peers — e.g. `@civitai/db` ⇒ also list
`@civitai/db-schema`).

## 4. The `process.env` shim (Vite/SvelteKit only)

SvelteKit/Vite load `.env` into `$env/dynamic/private`, **not** `process.env` — but the packages read
`process.env` **directly** (`loadDbEnv` / `loadRedisEnv` / `loadAuthEnv` / …). Bridge them in
`vite.config.ts` so the packages see config in dev + build:

```ts
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), ''); // '' = all vars, not just VITE_-prefixed
  for (const key in fileEnv) process.env[key] ??= fileEnv[key]; // fill gaps; real env wins
  return { plugins: [sveltekit()], ssr: { noExternal: [/* §3 */] } };
});
```

Vite reads the **app's own** `.env` (from `process.cwd()`), not the repo root — each app needs its own
`.env`. (Next.js loads `.env` into `process.env` natively, so it doesn't need this shim.)

## 5. Auth wiring (spoke gate)

For a `*.civitai.com` app, bind the policy and let a tiny framework adapter act on the guard's decision:

```ts
// src/lib/server/auth.ts
import { createSpokeGuard } from '@civitai/auth';
export const guard = createSpokeGuard({ require: (u) => u.isModerator === true });
```

```ts
// src/hooks.server.ts (SvelteKit) — Next: proxy.ts
export const handle = async ({ event, resolve }) => {
  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href);
  if (result.status === 'login')     return new Response(null, { status: 302, headers: { location: result.redirect } });
  if (result.status === 'forbidden') return new Response(null, { status: 303, headers: { location: 'https://civitai.com' } });
  event.locals.user = result.user;
  return resolve(event);
};
```

Allowlist public paths (e.g. `/favicon.svg`) before the gate. Depth — tiers, the hub→spoke contract,
registration — in the [spoke integration guide](../auth/spoke-integration-guide.md).

## 6. Data layer (Kysely, no Prisma engine)

```ts
// src/lib/server/db.ts
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
export const { dbRead, dbWrite } = createKyselyClients<DB>({
  connectionString: process.env.DATABASE_URL,
  replicaConnectionString: process.env.DATABASE_REPLICA_URL,
  sslNoVerify: true,
});
```

Use `@civitai/db/kysely` (env-free, explicit connection config, no Prisma engine) for a lightweight app;
use the `@civitai/db` Prisma entry only if you need Prisma — and note it then **requires** the full DB env
set (`DATABASE_URL`, `DATABASE_REPLICA_URL`, `NOTIFICATION_DB_URL`, `NOTIFICATION_DB_REPLICA_URL`).

## 7. Env requirements by package (cheat sheet)

Add to `.env` (real) + `.env.example` (documented) only the rows for packages you picked.

| Package | Required env | Notes |
|---|---|---|
| `@civitai/auth` | `AUTH_JWT_ISSUER`, `AUTH_JWKS_URI`, `AUTH_INTERNAL_TOKEN` | local hub: `http://localhost:5173` |
| `@civitai/db` (kysely) | *(none — explicit config)* | you pass connection strings |
| `@civitai/db` (Prisma) | `DATABASE_URL`, `DATABASE_REPLICA_URL`, `NOTIFICATION_DB_URL`, `NOTIFICATION_DB_REPLICA_URL` | full set required |
| `@civitai/redis` | `REDIS_URL` **and** `REDIS_SYS_URL` | **both or neither** — partial config throws |
| `@civitai/clickhouse` | `CLICKHOUSE_HOST`/`USERNAME`/`PASSWORD` | required in prod, optional in dev |
| `@civitai/email` | *(all optional)* | `isEmailConfigured()` guards sends |
| `@civitai/axiom` | *(all optional)* | stderr-only without `AXIOM_TOKEN` |
| `@civitai/brand`, `@civitai/telemetry`, `@civitai/db-schema` | *(none)* | |

**Redis footgun**: pulling `@civitai/auth` and setting only `REDIS_URL` (for the session cache) without
`REDIS_SYS_URL` makes `loadRedisEnv` throw — caught as fail-open, so you *silently* lose the cache. Set
both or leave both unset.

## 8. Dependency hygiene

- Declare a package only if you `import` it. Don't add transitive deps (`pg`, `kysely`) "to be safe."
- After wiring, **verify the trim**: remove a suspect dep, `pnpm install`, then `typecheck` **and** `build`
  — typecheck can pass on transitive type resolution while runtime still needs the dep (or vice-versa).
  (We dropped both `pg` and `kysely` from the moderator app this way.)
- `postcss.config.cjs = module.exports = {}` if the app uses plain CSS — otherwise PostCSS walks up to the
  root Next/Tailwind config and warns.
- Give the app its own `instrumentation.ts` shim (even empty) on Next 16 so it doesn't inherit the main
  app's instrumentation entry.

## 9. Verify

```bash
pnpm install
pnpm --filter @civitai/<name> run typecheck
pnpm --filter @civitai/<name> run build
```

Both must pass. Then run the app via the `/dev-server` skill and confirm the auth redirects end-to-end.
