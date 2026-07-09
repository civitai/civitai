# Auth hub — e2e smoke harness (Layer 2)

Deployed-environment Playwright smoke for the login hub. The hub analog of the main app's
`tests/preview-auth.setup.ts` + `playwright.preview.config.ts`: no local `webServer` — it hits a
**deployed** hub at `HUB_URL` and mints the session cookie out-of-band.

> ⚠️ **SCAFFOLD — not yet wired to CI / a live hub preview.** What's verified today: the stub OIDC
> server (`node stub-oidc-server.mjs --selftest` — passes). What's pending: a hub PR-preview
> environment (gated on the monorepo CI building `apps/auth` previews, which doesn't exist yet),
> the dep wiring below, and the first live run.

## Files

| File | Role |
|---|---|
| `playwright.hub.config.ts` | Config: targets `HUB_URL`, serial, report-only, `hub-setup` → `hub-smoke`. |
| `hub-fixtures.ts` | Shared roles (`ci-smoke-*` ids) + storageState paths. Not a test (excluded by `testMatch`). |
| `hub-auth.setup.ts` | Mints the thin ES256 session JWS with `jose` and writes a Playwright `storageState` per role. Mirrors the hub's `@civitai/auth` `mintSessionToken` claim shape exactly. |
| `hub-smoke.spec.ts` | Unauthenticated asserts (health, JWKS, `/login`) + authenticated identity asserts (gated on a trusted key). |
| `stub-oidc-server.mjs` | Deterministic upstream OIDC stand-in so the real `/login/[provider]/callback` path can run in CI without a live provider. Self-tested. |

## Trusted vs. ephemeral signing key (why some asserts skip)

The hub only accepts a session cookie signed with a key it **verifies** (its configured public key).
`hub-auth.setup.ts`:
- **`AUTH_JWT_PRIVATE_KEY` (+ `AUTH_JWT_KID`/`AUTH_JWT_ISSUER`) set** → mints with that key. If it's the
  key the target hub trusts, the cookie is accepted → `GET /api/auth/identity` asserts run.
- **unset** → generates a throwaway ES256 keypair. The cookie is structurally valid but the hub won't
  verify it → identity asserts **skip**; only the unauthenticated paths run.

The mode is recorded to `.auth/mint-mode.json`; the spec reads `trusted` to decide.

> The session cookie name is `civ-token` / `__Secure-civ-token` (NOT the legacy `civitai-token`) — the
> setup derives it via `@civitai/auth` `sessionCookieName()`, so it can't drift.

## Run it

Unauthenticated smoke works against ANY live hub today (incl. the dev-key `auth.civitai.com`):

```bash
# from repo root (root has @playwright/test, jose, uuid hoisted):
HUB_URL=https://auth.civitai.com \
  pnpm exec playwright test -c apps/auth/e2e/playwright.hub.config.ts
```

For the **authenticated identity** asserts, point at a hub preview whose keypair you have, and whose
DB has the seeded `ci-smoke-*` users (the cluster's `seed-smoke-test-users` job seeds
`cnpg-cluster-dev`):

```bash
HUB_URL=https://hub-pr-N.civitaic.com \
  AUTH_JWT_PRIVATE_KEY="$(…)" AUTH_JWT_KID=… AUTH_JWT_ISSUER=https://hub-pr-N.civitaic.com \
  pnpm exec playwright test -c apps/auth/e2e/playwright.hub.config.ts
```

Stub OIDC self-test (no deps):

```bash
node apps/auth/e2e/stub-oidc-server.mjs --selftest
```

## To wire into CI (the remaining work)

1. **Declare the test deps on `apps/auth`** (they're currently only root devDeps, so a strict pnpm
   resolve from `apps/auth` won't see them): add `@playwright/test`, `jose`, `uuid`, `@types/uuid` to
   `apps/auth/package.json` devDependencies and **regenerate `pnpm-lock.yaml`** (else the Docker
   `--frozen-lockfile` install breaks). Or always invoke from the repo root (where they're hoisted).
2. **Build an `apps/auth` PR-preview** (extend the datapacket-talos `pr-preview-pipeline`) so `HUB_URL`
   resolves to an ephemeral hub with a known keypair + the dev DB.
3. **Point a provider at the stub OIDC** in the preview env (override one provider's
   `authorizeUrl`/`tokenUrl`/`userinfoUrl` at `stub-oidc-server.mjs`) and add a callback spec that
   drives the real `/login/[provider]/callback` happy path.
4. **Add a CI step** running this config against the preview (report-only first; gate later).

## Coverage roadmap (this harness = Layer 2)

- **Layer 1 — unit** (shipped alongside): `apps/auth/src/lib/server/auth/__tests__/` + `@civitai/auth`.
- **Layer 2 — hub component e2e** (this dir): health/JWKS/login + identity; OAuth-callback via stub.
- **Layer 3 — hub↔spoke contract** (post-cutover, gated on the main app moving onto `@civitai/auth`):
  hub-minted token accepted by the main app; logout→revocation; ban→invalidate; legacy-JWE dual-accept;
  `.red` swap. This is the **acceptance test for the cutover**.
