# Local development setup

## Toolchain

Use the Node version in `.nvmrc` and the pnpm version in `package.json`'s `packageManager`. CI reads `.nvmrc` via `node-version-file:`, and the Dockerfile base image tracks it. On NixOS the flake derives its node major from `.nvmrc`, and `nix flake check` fails if they disagree.

## From nothing to a running app

Default path, no Nix:

```bash
nvm use
corepack enable
git submodule update --init event-engine-common
cp .env-example .env.development
docker compose -f docker-compose.base.yml up -d
pnpm install && pnpm dev
```

NixOS only (optional; one maintainer uses it, don't assume a contributor has it):

```bash
nix run .#dev                 # docker preflight, submodule, .env.development, compose up,
                              # wait for postgres, pnpm install, next dev on :3000
nix run .#dev -- --no-start   # bootstrap only
nix run .#doctor              # are the flake's pins still in step with the repo?
```

Required environment: database connection strings, authentication providers, S3/CloudFlare credentials, payment provider keys, search service endpoints.

### Windows toolchain and service addresses

- `fnm` can supply the pinned Node version on Windows. Activate it in the shell that starts the dev-server daemon; the daemon keeps its original interpreter until shutdown.
- If `corepack enable` fails with `EPERM` under `C:\Program Files\nodejs`, use a user-writable Node installation or install the pnpm version declared in `packageManager` with `npm install --global pnpm@<version>`.
- Git Bash rewrites Unix-looking command arguments. If `docker exec … /bin/sh` becomes a path under `C:/Program Files/Git`, prefix that command with `MSYS_NO_PATHCONV=1`. PowerShell does not need that prefix.
- If a backend connection through `localhost` fails but `127.0.0.1` works, use IPv4 loopback for that service. Check `DATABASE_URL`, `DATABASE_REPLICA_URL`, `DATAPACKET_DATABASE_RO_URL`, `NOTIFICATION_DB_URL`, Redis, ClickHouse and search URLs. Keep the browser-facing app and auth URLs consistent with the hostname used to sign in.

## In an existing checkout

1. `pnpm install`
2. `pnpm run db:generate`
3. `make start` if the services are down.
4. Start the dev server with the `/dev-server` skill. The daemon keeps whichever node first ran a CLI verb (`process.execPath`) until shutdown, so start it under the node from `.nvmrc`. On NixOS, `nix run .#dev-server` does this, except while the locked nixpkgs lags `.nvmrc`'s patch (see the note in `flake.nix`).

## Email

Local dev never uses real mail credentials. Every email goes to the Mailpit catcher in `docker-compose.base.yml` (`docker compose -f docker-compose.base.yml up -d mailpit`): SMTP on `localhost:1025`, inbox UI and API at http://localhost:1080. The dev-server daemon forces the catcher's `EMAIL_*` values into every app it starts, whatever the `.env` chain says, and `wt new` and `wt env --refresh` write them into each `.env` they copy. Commented-out mail lines left in an older local `.env` are dead values; delete them. With Mailpit down a send fails with a connection error; nothing falls back to a real server.

## Local services and image feeds

Keep machine-specific compose changes in an untracked override, for example `docker-compose.local.yml` listed in `.git/info/exclude`. Pass both files when using it:

```bash
docker compose -f docker-compose.base.yml -f docker-compose.local.yml up -d
```

- **MinIO images fail to pull.** The compose file still names `minio/minio` and `minio/mc`. [#5186](https://github.com/civitai/civitai/pull/5186) proposes replacement images; an override must cover both `minio` and `createbuckets`.
- **ClickHouse rejects the passwordless `default` user.** For the local credentials in `.env-example`, the `clickhouse` service can use `CLICKHOUSE_SKIP_USER_SETUP=1` in its environment. Alternatively, configure a user/password consistently in ClickHouse and the app.
- **The image feed reports `Unknown field sort` from `/documents/fetch`.** The compose file pins Meilisearch v1.11, while the feed uses a newer fetch API. A local override with `getmeili/meilisearch:v1.35` supports that request. Changing the image tag does not migrate existing index files: preserve any index data you need and follow the server's version-upgrade procedure before rebuilding local search indexes.
- **Collection or user galleries report `relation "CollectionItem" does not exist`.** `.env-example` points `DATAPACKET_DATABASE_RO_URL` at `logical-db` on port 15435, a replication stub, not the application database. When the `datapacketRead` path is enabled, point that URL at the same local database as `DATABASE_URL`.

The auth hub's PostgreSQL SSL requirement is covered under [Traps that cost hours](#traps-that-cost-hours).

## Database, seed and search checks

`make run-migrations` uses `scripts/local-dev/run_migrations.ts`. Investigate each reported failure against the local baseline and the migration's SQL. Operations such as `CREATE INDEX CONCURRENTLY` cannot run inside a transaction; adding an enum value and using it in the same transaction also needs separate steps. Follow the manual migration procedure in `.claude/rules/database.md`, including its post-apply checks. Do not record a failed migration as applied without verifying its intended schema change.

`make reseed` runs the seed and then the metrics/search bootstrap. It truncates existing seed data, including the notification database, so run it only against disposable local databases. The URL guards in `scripts/local-dev/local-db-guard.ts` check both database connections. Bootstrap continues past individual job failures, reports them and exits nonzero if any failed; inspect that summary even when some indexes were built. Some jobs depend on ClickHouse aggregates absent from a local setup.

If pages are still empty or show broken previews:

- **Check preview URLs.** `gen_seed.ts` uses `faker.image.url()`, so preview availability depends on an external image service. Inspect a failing URL before changing seed records; a bot-check page or non-image response is not an app rendering failure.
- **Check article ingestion.** Public article listings and search indexing require published articles to be scanned; listing requests have owner and moderator exceptions. When using synthetic local content without a running scanner, published seed articles can be marked scanned before targeted article indexing:

  ```sql
  UPDATE "Article"
  SET ingestion = 'Scanned', "contentScannedAt" = COALESCE("contentScannedAt", now())
  WHERE status = 'Published' AND ingestion = 'Pending';
  ```

- **Check the selected date window.** Archived fixtures may have no records in the current week. Try `/images?period=AllTime` or `/videos?period=AllTime` before diagnosing an empty feed as an index failure.
- **Check homepage data.** A `HomeBlock` of type `Collection` needs the referenced collection and accepted items of its declared type. Featured collections need public collections with visible items. Featured model versions are selected from validity windows covering today or either of the previous two days; if none match, selection falls back to published versions in the featured-model collection. Use published, scanned, PG-rated fixtures when checking the signed-out page. Image contest collections randomize their items and hide reaction counts through the existing collection/homepage components.
- **Refresh the affected caches.** Use `homeBlockCacheBust` for the changed collection/block and `bustSystemHomeBlockCaches` for system-block changes (`src/server/services/home-block-cache.service.ts`). For collection memberships, also update the affected image index documents; clearing homepage caches does not update indexed membership. Avoid clearing all Redis keys or rebuilding every index for a small fixture change.

Check `/api/health?token=<WEBHOOK_TOKEN>`, search-index document counts, and real browser loads of `/models`, `/images`, `/articles` and a collection. Verify signed-in requests as well as signed-out pages; a working anonymous homepage does not establish that the auth hub is configured.

## Moderator app

The main `.env-example` sets `MODERATOR_APP_URL` to `https://moderator.civitai.com`. To test moderation locally, edit that existing value to `http://localhost:5174` and configure `apps/moderator/.env` from its example with local service URLs and the shared local auth settings. Start it through the dev-server skill:

```bash
node .claude/skills/dev-server/cli.mjs start --app moderator
```

Moderator access requires the relevant local account permissions; normal test accounts do not need moderator access. After a reseed, check any roles you previously created: `TRUNCATE "User" … CASCADE` can also empty tables related to users. Confirm that admin links stay on the local moderator origin before testing them.

## Analytics and ads on a local origin

A local build (including `next build` + `next start`) can send tracker, Google Analytics and ad requests; they are off by default when `NEXT_PUBLIC_CIVITAI_LINK` is a loopback origin (or unset outside production). Set `NEXT_PUBLIC_LOCAL_TRACKER_ENABLED=true` (tracker and Google Analytics) or `NEXT_PUBLIC_LOCAL_ADS_ENABLED=true` (ads) to opt in.

## Traps that cost hours

Each presents as something other than its cause. None is OS-specific.

- **`.env.development` is silently inert for any key `.env` also defines, when the dev-server daemon starts the app.** The daemon injects the primary checkout's `.env` into the child's environment, and a real env var beats dotenv files. Keys absent from `.env` do get through, so half your overrides work. Running `pnpm dev` directly uses normal Next precedence. Diagnose with `@next/env`'s `loadEnvConfig`, not by reading the process environment (`/proc/<pid>/environ` shows only exec-time values, never dotenv-loaded ones). The tell: an override that plainly should work doesn't, e.g. a connection error naming a host you already changed.
- **Sign-in needs the auth hub, and `apps/auth/.env` is gitignored, so a fresh clone has none.** It needs an EC P-256 keypair whose private half is PKCS8 (a SEC1 key throws at import), an issuer/JWKS pair pointing at the hub's own port, and `NEXTAUTH_SECRET` + `AUTH_INTERNAL_TOKEN` identical to the main app's. Start it via the `/dev-server` skill's `auth` verbs. Verify that the hub's JWKS endpoint serves the `kid` of the key you just generated.
- **The hub always connects to Postgres over SSL, and a stock local Postgres has none.** It rewrites its connection string to `sslmode=no-verify`, so `?sslmode=disable` does nothing. Login fails with a generic "Something went wrong on our end." and the real error (`The server does not support SSL connections`) is only in the hub's log. Give the local database a self-signed certificate and enable SSL; `no-verify` accepts it.
- **Incomplete onboarding can hide local pages behind the wizard.** The app checks the required `onboarding` bits for the current domain; `OnboardingComplete` (`src/server/common/enums.ts`) includes the default required steps. Ordinary test accounts do not need `isModerator`; moderation access has separate permission checks. After manually editing session-user fields, refresh that user's session through `refreshSession(userId)` in `src/server/auth/session-invalidation.ts` so the hub rebuilds its cached user data.
- **Stripe keys in a local `.env` must be sandbox keys** (`sk_test_`/`pk_test_`); setup and the
  catalogue sync are in `docs/dev/stripe-sandbox.md`.
- **Feature flags have two independent paths.** Client/SSR gates read the feature-flag service, which honours `FEATURE_FLAG_<KEY>=public` (see `getEnvOverrides` in `src/server/services/feature-flags.service.ts`). Several server-side gates call Flipt directly and fail closed, so the env override doesn't reach them: you get a rendered page with an empty result set that looks like a broken query. Take the flag's real key from `fliptKey` in that service, never from the camelCase name; an unknown key evaluates false and looks like a legitimately-off feature.
- **A flag declared `availability: []` that also carries a `fliptKey` can't be switched on with `FEATURE_FLAG_<KEY>`.** Flipt alone decides. Use `FLIPT_LOCAL_OVERRIDES=<fliptKey>=on`: comma-separated `key=value` pairs keyed by `fliptKey`, `on`/`off` for booleans, ignored when `NODE_ENV=production`. It reaches the feature-flag service and every `isFlipt`/`isFliptSync` gate, but not `getFliptBoolean` gates, which ignore local overrides by design.
- **A flag with `availability: []` and no `fliptKey` is the opposite case.** `coinbasePayments` and `nowpaymentPayments` (legacy array form, e.g. `coinbasePayments: []`) are switched only by `FEATURE_FLAG_<KEY>`; `FLIPT_LOCAL_OVERRIDES` can't reach them because there is no key to name. Check for a `fliptKey` before concluding a dark flag is unswitchable.
- **App Blocks need a signing keypair or they 503.** With `BLOCK_TOKEN_PRIVATE_KEY` / `BLOCK_TOKEN_PUBLIC_KEY` unset, `POST /api/v1/block-tokens` returns `Block tokens not configured` and the UI says "Couldn't authenticate this app". The `kid` is derived from the key, so no third variable is needed. A block's iframe loads from the origin in its manifest, which is usually not served locally, so the host sits on its boot skeleton indefinitely.
- **`data-testid` attributes are stripped from production builds** (`reactRemoveProperties` in `next.config.mjs`). Reliable locally; they match nothing against a deployed environment.

## Memory or debugger

`pnpm run dev-debug` starts the app with an 8 GB heap and `--inspect`.

For a slow or stuck dev route, use the dev-server skill's bounded probe first:

```bash
node .claude/skills/dev-server/cli.mjs probe /api/user/settings
```

The probe distinguishes framework compilation/cache problems from time spent in application code, stale dependencies and a failing settings bootstrap. Use `unwedge <session-id>` only for a `WEDGED` verdict; it removes the session's build cache and restarts with a cold compile. A route taking the settings-bootstrap timeout is not, by itself, evidence of cache corruption. See `.claude/skills/dev-server/SKILL.md` for the verdicts and their remedies.
