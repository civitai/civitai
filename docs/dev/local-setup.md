# Local development setup

## Toolchain

Use node `24.19.0` and pnpm 10.x. `.nvmrc` is the authority (CI reads it via `node-version-file:`, the Dockerfile base image tracks it); `package.json` declares `engines.node: ">=24.0.0 <25"`. On NixOS the flake derives its node major from `.nvmrc`, and `nix flake check` fails if they disagree.

## From nothing to a running app

Default path, no Nix:

```bash
nvm use                                        # .nvmrc -> 24.19.0
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

## In an existing checkout

1. `pnpm install`
2. `pnpm run db:generate`
3. `make start` if the services are down.
4. Start the dev server with the `/dev-server` skill. The daemon keeps whichever node first ran a CLI verb (`process.execPath`) until shutdown, so start it under the node from `.nvmrc`. On NixOS, `nix run .#dev-server` does this.

## Traps that cost hours

Each presents as something other than its cause. None is OS-specific.

- **`.env.development` is silently inert for any key `.env` also defines, when the dev-server daemon starts the app.** The daemon injects the primary checkout's `.env` into the child's environment, and a real env var beats dotenv files. Keys absent from `.env` do get through, so half your overrides work. Running `pnpm dev` directly uses normal Next precedence. Diagnose with `@next/env`'s `loadEnvConfig`, not by reading the process environment (`/proc/<pid>/environ` shows only exec-time values, never dotenv-loaded ones). The tell: an override that plainly should work doesn't, e.g. a connection error naming a host you already changed.
- **Sign-in needs the auth hub, and `apps/auth/.env` is gitignored, so a fresh clone has none.** It needs an EC P-256 keypair whose private half is PKCS8 (a SEC1 key throws at import), an issuer/JWKS pair pointing at the hub's own port, and `NEXTAUTH_SECRET` + `AUTH_INTERNAL_TOKEN` identical to the main app's. Start it via the `/dev-server` skill's `auth` verbs. Verify that the hub's JWKS endpoint serves the `kid` of the key you just generated.
- **The hub always connects to Postgres over SSL, and a stock local Postgres has none.** It rewrites its connection string to `sslmode=no-verify`, so `?sslmode=disable` does nothing. Login fails with a generic "Something went wrong on our end." and the real error (`The server does not support SSL connections`) is only in the hub's log. Give the local database a self-signed certificate and enable SSL; `no-verify` accepts it.
- **Two DB columns gate a usable local account.** `isModerator`, and `onboarding`, which must equal `OnboardingComplete` (`src/server/common/enums.ts`); otherwise every gated route renders the "Welcome!" onboarding wizard (often with a hydration error), which looks like the route being broken. Sessions are cached: after changing either column, clear the Redis caches and log in again.
- **Feature flags have two independent paths.** Client/SSR gates read the feature-flag service, which honours `FEATURE_FLAG_<KEY>=public` (see `getEnvOverrides` in `src/server/services/feature-flags.service.ts`). Several server-side gates call Flipt directly and fail closed, so the env override doesn't reach them: you get a rendered page with an empty result set that looks like a broken query. Take the flag's real key from `fliptKey` in that service, never from the camelCase name; an unknown key evaluates false and looks like a legitimately-off feature.
- **A flag declared `availability: []` that also carries a `fliptKey` can't be switched on with `FEATURE_FLAG_<KEY>`.** Flipt alone decides. Use `FLIPT_LOCAL_OVERRIDES=<fliptKey>=on`: comma-separated `key=value` pairs keyed by `fliptKey`, `on`/`off` for booleans, ignored when `NODE_ENV=production`. It reaches the feature-flag service and every `isFlipt`/`isFliptSync` gate, but not `getFliptBoolean` gates, which ignore local overrides by design.
- **A flag with `availability: []` and no `fliptKey` is the opposite case.** `coinbasePayments` and `nowpaymentPayments` (legacy array form, e.g. `coinbasePayments: []`) are switched only by `FEATURE_FLAG_<KEY>`; `FLIPT_LOCAL_OVERRIDES` can't reach them because there is no key to name. Check for a `fliptKey` before concluding a dark flag is unswitchable.
- **App Blocks need a signing keypair or they 503.** With `BLOCK_TOKEN_PRIVATE_KEY` / `BLOCK_TOKEN_PUBLIC_KEY` unset, `POST /api/v1/block-tokens` returns `Block tokens not configured` and the UI says "Couldn't authenticate this app". The `kid` is derived from the key, so no third variable is needed. A block's iframe loads from the origin in its manifest, which is usually not served locally, so the host sits on its boot skeleton indefinitely.
- **`data-testid` attributes are stripped from production builds** (`reactRemoveProperties` in `next.config.mjs`). Reliable locally; they match nothing against a deployed environment.

## Memory or debugger

`pnpm run dev-debug` starts the app with an 8 GB heap and `--inspect`. For a broken build: delete `.next`, reinstall `node_modules`, then look for circular imports.
