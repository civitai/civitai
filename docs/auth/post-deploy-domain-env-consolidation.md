# Post-deploy: consolidate the domain / origin env vars

**Status:** planned follow-up (do *after* the auth-hub cutover deploy has stabilized).
**Goal:** collapse the several overlapping ways the app answers *"what is my origin?"* down to one
source of truth, and retire `NEXT_PUBLIC_BASE_URL`.

---

## Why

The app is deployed **once** but served on **multiple hosts** — the color/domain system
(`green`/`blue`/`red`, each with a primary + aliases; see
[multi-host-domain-aliases.md](../multi-host-domain-aliases.md)). On a multi-host deploy there is **no
single canonical URL** — the right origin is *per-request* (which host did this request arrive on?).

`NEXT_PUBLIC_BASE_URL` is a **single static** value, so every outbound URL built from it is wrong on
every host except the canonical one. It's also a `NEXT_PUBLIC_` var (baked into the client bundle at
build time), so one build serving N hosts **can't** carry a correct value for all of them.

**Exhibit A (already fixed):** `src/pages/api/auth/sync.ts` built the cross-domain login callback from
`NEXT_PUBLIC_BASE_URL`, so `test-auth.civitai.red` emitted a callback to `pr-2468.civitaic.com` → the
hub 400'd it → redirect loop. The fix routed it through the color primary instead. That class of bug
recurs anywhere `NEXT_PUBLIC_BASE_URL` is used for an outbound URL (~27 files today).

## Source of truth

The **color/domain map** (`SERVER_DOMAIN_<COLOR>` + `_ALIASES`) is the one place that knows which hosts
this deploy serves and their canonical primaries. Everything origin-shaped should derive from it:

- **Server** → `getBaseUrl(getRequestDomainColor(req))` — the primary for the host the request came in
  on. Both helpers already exist:
  - `getRequestDomainColor(req)` — [src/server/utils/server-domain.ts](../../src/server/utils/server-domain.ts)
  - `getBaseUrl(color)` / `serverDomainPrimaryMap` — [src/server/utils/url-helpers.ts](../../src/server/utils/url-helpers.ts)
- **Client** → `window.location.origin` — the runtime host, always correct, needs **no env var**.

## Inventory (what to keep / retire)

| Input | Role | Action |
|---|---|---|
| `SERVER_DOMAIN_<COLOR>` (+ `_ALIASES`) | per-color host map | **keep** — the source of truth |
| `NEXT_PUBLIC_BASE_URL` | single static base URL | **retire** — redundant + wrong on multi-host |
| `getBaseUrl(color)` / `getRequestDomainColor` | per-request origin | **keep** — the canonical resolver |
| `NEXTAUTH_URL` | legacy hub/base URL | **retire** after cutover (sunset with legacy cookies) |
| `NEXTAUTH_COOKIE_DOMAIN` | legacy cookie domain | **retire** after legacy cookies age out |
| `AUTH_JWT_ISSUER` | hub origin / JWT `iss` | keep (distinct concern — the hub identity) |
| `AUTH_COOKIE_DOMAIN` | session cookie `Domain` | keep, but now **defaulted** (see below) |
| `AUTH_SPOKE_ORIGINS` | *(was)* hub's cross-site spoke allowlist | **RETIRED** — replaced by the `TrustedSpokeDomain` DB table (see below) |
| `AUTH_SWAP_MAX_AGE` | *(was)* swap-token TTL | **RETIRED** — the swap-token bridge was deleted; first-party login now rides the OAuth auth-code flow |
| `AUTH_JWT_AUDIENCE`, `AUTH_SESSION_COOKIE` | *(never wired)* | **RETIRED** — drop from any deploy env: the hub emits no `aud`, and the cookie name is the hardcoded `civ-token` constant |

## Migration plan

### Phase 0 — done
- Cross-domain login no longer touches `NEXT_PUBLIC_BASE_URL`: `sync.ts` was **removed** with the
  swap-token bridge, and its replacement — the spoke `/api/auth/callback` — derives this spoke's origin
  from the ACTUAL request host (`resolveSelfOrigin`), which the hub validates against `TrustedSpokeDomain`.
- `AUTH_SPOKE_ORIGINS` retired → `TrustedSpokeDomain` DB table + `createTrustedDomainRegistry` (see
  *Related consolidations*).
- Hub cookie `Domain` is defaulted via a single `cookieDomain()` helper
  ([apps/auth/src/lib/server/auth/cookie.ts](../../apps/auth/src/lib/server/auth/cookie.ts)):
  `AUTH_COOKIE_DOMAIN` override, else `.civitai.com` on HTTPS, else host-only on localhost. Used by
  `setSessionCookie`, `clearSession`, and the device cookie.

### Phase 1 — one server-side resolver
- Add `getRequestBaseUrl(req) = getBaseUrl(getRequestDomainColor(req))` (server util).
- Point the **server** `NEXT_PUBLIC_BASE_URL` sites at it (~8 files under `src/pages/api` + `src/server`).
- Collapse `/login`'s hand-rolled `x-forwarded-host` parsing
  ([src/pages/login/index.tsx](../../src/pages/login/index.tsx)) into the same helper.

### Phase 2 — client + request-less contexts
- **Client** sites (~9 in `src/components`) → `window.location.origin` (or a relative URL). Watch SSR:
  a client component rendered server-side has no `window` — prefer relative URLs, or thread the host
  through props/context.
- **Request-less** server code (OG images, email templates, sitemap, webhooks, cron) has no request to
  resolve a color from. Give these an **explicit** canonical: `getBaseUrl(<defaultColor>)` or a single
  new `CANONICAL_URL` var. Decide the default color per deploy (the "primary color" of the box).

### Phase 3 — delete the var
- Remove `NEXT_PUBLIC_BASE_URL` from [src/env/client-schema.ts](../../src/env/client-schema.ts) and every
  `.env` / deploy manifest.

## Gotchas (the hard 20%)

- `getBaseUrl(color)` hardcodes `https://<primary>`. For localhost multi-color dev that yields
  `https://localhost:<port>` — fine for the cookie/issuer checks (hostname-only), but if you build a
  redirect target from it locally, gate the protocol (`localhost → http`) as `sync.ts`'s helper does.
- Behind the edge proxy, the real host is in `x-forwarded-host` (comma-joined) — resolve
  `x-forwarded-host ?? host` and take the first segment before feeding `getRequestDomainColor`.
- An unrecognized inbound Host must **not** become an outbound origin (open-redirect / cookie-scope
  risk). The resolver only maps a *configured* primary/alias; unknown hosts fall back to the configured
  default — never the raw `Host`. Preserve that invariant in every migrated site.

## Related consolidations (same theme, optional)

- **`AUTH_SPOKE_ORIGINS` — RETIRED (done, 2026-06-22).** The hand-kept env allowlist was replaced by the
  `TrustedSpokeDomain` DB table (migration `20260622180000_add_trusted_spoke_domain`), managed in-app via
  the hub `/admin` UI and read through a ~60s in-memory cache (`createTrustedDomainRegistry` in
  `@civitai/auth`). The hub resolves a first-party client by the request's redirect_uri **origin** against
  that registry (exact host, or any subdomain when `includeSubdomains` — e.g. the `civitaic.com` preview
  wildcard for ephemeral PR hosts), so enabling a login host is now **one DB row**, not an env edit. This
  fixes the old **F5** silent-per-color-login failure at the root (no parallel list to drift). The
  companion post-login redirect guard `isCivitaiOrigin` reads `CIVITAI_OWNED_DOMAINS` in `@civitai/auth`
  (the family eTLD+1s: `civitai.com`, `civitai.red`, `civitaic.com`) — **keep that list aligned** with the
  registry's owned domains, since the two gates answer different questions (registrable-domain ownership
  vs. per-host authorization) but must both recognize every family domain.
- **`AUTH_COOKIE_DOMAIN`** now has a sane default; a fuller version could derive the parent domain from
  the hub's `ORIGIN` registrable domain rather than the hardcoded `.civitai.com`.

## Acceptance criteria

- `grep -r NEXT_PUBLIC_BASE_URL src` → **0** (outside this doc).
- `pnpm run typecheck` + unit suite green.
- Multi-host smoke: on each alias host, outbound URLs (sync callback, OG image, `<link rel=canonical>`,
  referral/share links) point at **that host's** color primary — never the canonical-only value.
- Rollback is trivial: re-add the env var + revert the per-site changes; no data/migration involved.
