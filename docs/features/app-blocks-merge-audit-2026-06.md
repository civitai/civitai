# App Blocks Foundation — Pre-Merge Audit (2026-06-12)

Audit of PR #2319 (`feat/app-blocks-main-v1`, HEAD `68f4e0fd3`) before merging the App
Blocks / wider app-system foundation into `main`. Goal of the milestone: **ship the
foundation dark (no user-facing release) so the work stops diverging from `main`.**

Method: five parallel read-only auditors across security, gating/leaks, correctness,
DB/migrations/perf, and money/second-order. Findings verified against code; the Flipt
state was confirmed against the live GitOps source of truth (`civitai/flipt-state`).

## TL;DR

**Safe to merge as a dark launch.** Server-side the substrate is fully off (see H2),
migrations only touch new tables, the hot model-page path is inert when dark, no real
money moves, and the security substrate is genuinely hardened (no Critical/High security
exploit found). The red CI was a **faulty test assertion**, now fixed. The items below
are tracked follow-ups; all MEDIUMs are **GA-blockers, not merge-blockers**.

## Feature-flag resolution (verified against live Flipt state)

Live `app-blocks-enabled` (`civitai/flipt-state` → `civitai-app/default/features.yaml`):

```yaml
- key: app-blocks-enabled
  enabled: false                 # base = OFF
  rollouts:
    - segment: { keys: [moderators] }   # moderators segment: isModerator == "true"
```

How `appBlocks` resolves in `hasFeature` (`feature-flags.service.ts`): when a Flipt rule
returns non-null it **overrides** the code `availability: ['mod']` in both directions —
the role list is only a Flipt-down fallback. The flag description itself documents this.

- **H1 — anon exposure: NOT active.** A *global* `enabled: true` would expose App Blocks
  to all users; the team correctly used a `moderators`-segmented rollout with base
  `enabled: false`. Non-mods/anon resolve to `false`. ✅
- **H2 — server/client gate divergence: ACTIVE.** Two different Flipt evals are in play:
  - Per-user/client gate `getFeatureFlags({user})` passes `isModerator` → mod segment
    matches → `appBlocks = true` → `BlockSlot` mounts.
  - Server gate `isAppBlocksEnabled()` → `isFlipt('app-blocks-enabled')` defaults to
    `entityId='global'`, `context={}` (no `isModerator`) → segment can't match → base
    `false`. Used by `enforceAppBlocksFlag`, the token-mint 503 pre-check, JWKS,
    `withBlockScope`, and all mutations.
  - **Net:** App Blocks is fully OFF server-side even for mods. A moderator's client
    mounts the slot, then every token mint 503s / `listForModel` returns `[]` / mutations
    are UNAUTHORIZED. This is why the throwaway preview branch (#2457) has to relax the
    flag to public to exercise the flow.
  - **Consequence:** safe for the dark launch (more dark, not less), but the intended
    "mod canary" does not work — there's no clean way to dogfood on `main` short of a
    global enable (which H1 warns exposes everyone).
  - **Fix:** thread `isModerator`/user context into `isAppBlocksEnabled()` (and the
    other server gates) so they evaluate the same segment context the client does;
    or make `availability` clamp Flipt *enablement* (Flipt can disable but not widen
    past `['mod']`). Then a `moderators`-segmented flag works end-to-end without
    exposing non-mods.

## Findings

### Resolved
- **CI-blocking unit test was faulty (not a real bug).**
  `storage-provision.service.test.ts` matched the throwing DDL with
  `sql.startsWith('CREATE TABLE …')`, but the service emits it as an indented template
  literal (leading whitespace), so the mock never threw and `provision()` resolved
  instead of rejecting. The production rollback path is correct
  (`COMMIT` in try; `catch { ROLLBACK; throw }`; `finally { release() }`). Fixed the
  matcher to `trimStart().startsWith(...)`; all 11 tests pass.

### HIGH
- **H2 — server/client flag-gate divergence** (see above). Action: unify the gate
  context so the mod canary works without a global enable. Not a merge-blocker (it fails
  safe), but blocks any mod dogfooding on `main`.

### MEDIUM (GA-blockers)
- **PII to third-party iframe.** `BLOCK_INIT` spreads the whole context to the publisher
  iframe, including `viewerNsfwEnabled` and `creatorUserId`. Project to an allowlist
  before GA. (Transport is safe: exact-origin postMessage, source-window pinned.)
- **Showcase images not browsing-level filtered.** `getShowcaseImages` returns NSFW image
  URLs + prompts/seeds to the block regardless of viewer setting. Filter by browsing
  level / `viewerNsfwEnabled` before GA.
- **git-push trust-on-push.** Once an `app_blocks` row exists, any signature-valid Forgejo
  push to `main` re-ships + re-marks it `approved`, deploying new iframe code without mod
  re-review. Gate post-approval pushes (or restrict Forgejo write to platform) before GA;
  ship the deferred audit-log line for manifest/`iframe.src` swaps.
- **Daily buzz cap is per-app-block and fails open.** `BLOCK_BUZZ_CAP_PER_DAY = 50_000`
  is per `(user, app_block, day)`, and the Redis counter under-counts on a blip. Make it a
  per-user aggregate before GA.
- **`kill_per_model_installs` migration FK repoint.** Aborts if any `block_user_settings`
  row maps to an install with a NULL installer (deleted user). **Pre-flight per env**
  before applying: `SELECT count(*) FROM block_user_settings bus JOIN model_block_installs
  mbi ON mbi.block_instance_id = bus.block_instance_id WHERE mbi.installed_by_user_id IS
  NULL;` must be 0.

### LOW / INFO
- DB safe overall: 9/10 migrations are CREATE-only / ALTER-only on **new** tables; the one
  destructive migration drops a *new* table; FK cascades flow the safe direction (deleting
  a User/Model cannot cascade-delete an existing-table row).
- Schema drift: `AppUserScopeGrant` missing from generated `prisma/schema.prisma` — run
  `db:generate` and commit.
- `invalidateModelCache` uses `scanIterator` (the #2434 SCAN-bust pattern) — but only on
  mod write paths, ≤3 keys. Prefer a deterministic multi-DEL of the known slot keys.
- ~~Global change: tRPC body limit raised 17mb → 72mb for all requests~~ — **RESOLVED**:
  the W1 bundle upload moved to a dedicated `POST /api/blocks/submit-version` route
  (72mb, ModEndpoint mod-gated + appBlocks-flag-gated); the shared `/api/trpc/[trpc]`
  route is back to 17mb. `submitVersion` was the only tRPC path needing >17mb (KV
  `storage.set` is capped at 64KB).
- Dead deps: `@civitai/app-sdk`, `@civitai/blocks-react` declared but never imported
  (comment references only) — no bundle impact; confirm intentional.
- Smaller: `git-push` `sha` lacks hex-shape validation; `workflow-completed` returns 200
  on a Redis error (drops a completion; scaffold); Paddle attribution path unvalidated
  (dead today); provider fee defaults to 0 (publisher marginally overpaid); webhooks lack
  replay/timestamp protection (idempotency-mitigated); `internalAppOwnerUserIds` empty +
  rate-card percentages are placeholders — **do not wire the payout job until sign-off**;
  `getBlockTokenVerificationKeys()` (all-keys verifier) dead but still exported.

### Confirmed safe
- Security substrate hardened: same-origin exact-match token mint, RS256 JWT with
  kid/iss/aud/exp + alg-pinning, sandbox intersection + server validator, postMessage
  origin **and** source-window pinning, CORS never `*`, strong lexical SSRF gate, webhook
  HMAC with `timingSafeEqual`, parameterized KV isolation, OAuth account-takeover vectors
  closed.
- No real money moves (disbursement stubbed); attribution server-validated against the
  authenticated buyer; idempotency via unique constraints; share conservation enforced by
  DB CHECK; self-purchase voided; revenue dashboard scoped to owner.
- Hot path cheap when dark: per-model-page SSR prefetch hits an in-process cached Flipt
  eval and early-returns `[]` before any DB/Redis I/O.
- No correctness regressions in shared files; failing third-party blocks collapse to
  `null` via error boundary without breaking the model page.

## Action checklist

**Before merge (dark launch):**
1. ~~Fix the faulty `storage-provision` test~~ — done.
2. Confirm Flipt `app-blocks-enabled` stays base `enabled: false` + `moderators` segment
   (verified 2026-06-12).
3. Run the `kill_per_model_installs` pre-flight per environment before applying migrations.
4. Apply the 9 app-blocks migrations manually (CREATE-only; non-breaking).
5. Optional: regenerate + commit `prisma/schema.prisma` (`AppUserScopeGrant`).

**Before GA (turning it on):** H2 gate unification; iframe PII allowlist; showcase NSFW
filter; git-push post-approval review + audit log; per-user buzz cap; rate-card sign-off
before any payout wiring.

---

## Security audit (2026-06-13, dedicated security-engineer pass on shipped `5643eaba7`)

A second, security-specialist audit of the **as-shipped** foundation (post-merge, live in
prod, dark). It independently re-verified the panel audit's "hardened" claim against the
live code and went deeper on the third-party-execution / auth / money surfaces.

**Verdict: ✅ safe to remain dark · ⛔ No-Go for GA until the GA-blockers below are fixed.**
No Critical/High issue is reachable by a non-moderator while the flag is off; the
crypto/auth core (RS256 kid-pinned JWT, exact-origin mint, PKCE-S256 OAuth, sanitized KV
schema isolation, lexical SSRF gate, source-window-pinned postMessage, timing-safe webhook
HMAC) is genuinely well-built and the dark boundary holds across routers/JWKS/middleware/SSR.

### Reachable while dark
- **`build-callback` had no flag gate + no replay protection — FIXED in this change.**
  Unlike its siblings (`git-push`, `workflow-completed`), `build-callback.ts` never checked
  the flag, so the k8s apply/deploy path could run independent of the kill switch; and the
  timestamp/nonce-less payload meant a captured signed callback could be replayed to
  re-trigger applies. Added: `isFlipt('app-blocks-enabled')` 503 gate + a short-window
  (15m) `(appBlockId, sha)` apply-path replay guard (fail-open on Redis loss). Handler-level
  tests cover both. Durable cross-window replay protection still needs a caller-supplied
  signed timestamp/nonce from the Tekton finally task — **infra follow-up**.
- **INFO — H2 gate divergence confirmed** (fails safe; mod canary can't exercise the flow
  server-side until context is threaded into the server gate — fix by threading, NOT a
  global enable).

### GA-blockers (reachable only after the flag is turned on)
1. **🔴 HIGH — Showcase images bypass NSFW/browsing-level filtering.**
   `showcase.service.ts` selects `nsfwLevel` but never filters on it and ignores the viewer
   setting → explicit image URLs + prompts + seeds for an X-rated model are posted into the
   third-party iframe (`BLOCK_INIT`) for any viewer, incl. opted-out / logged-out. Fix:
   filter by browsing level / `viewerNsfwEnabled` (SFW-only for anon) before returning.
2. **MEDIUM — `submit-version` CSRF (confirmed).** Prod session cookie is `sameSite:'none'`
   (`next-auth-options.ts`) and `ModEndpoint` does no Origin/CSRF check; Next.js parses
   `application/x-www-form-urlencoded`, so a cross-site form POST with a tricked mod's cookie
   can submit a bundle. Pre-existing, app-wide `ModEndpoint` posture (not unique to this
   route); dark-gated today. Fix: explicit same-origin/Origin check (ideally on `ModEndpoint`).
3. **MEDIUM — Bundle ZIP zip-bomb.** `publish-request.service.ts` fully decompresses each
   entry before size-checking; 2000 × 10 MiB ⇒ ~20 GiB from a 50 MiB upload → pod OOM.
   (Zip-slip is NOT exploitable — jszip normalizes `..`, files go to Forgejo content API.)
   Fix: running decompressed-byte ceiling.
4. **MEDIUM — git-push trust-on-push** auto-approves + deploys live third-party code with no
   mod re-review once a row exists (iframe.src/blockId stay pinned, but the served code
   changes). Fix: gate post-approval pushes behind the review queue; restrict Forgejo write;
   ship the deferred manifest/iframe.src/sha audit-log.
5. **MEDIUM — BLOCK_INIT over-shares** `viewerNsfwEnabled`, `creatorUserId`, viewer
   id/username/status to the publisher iframe. Transport is sound; data-minimization only.
   Fix: allowlist-project the context before `send('BLOCK_INIT', …)`.
6. **MEDIUM — Buzz cap is per-(user,block), not per-user aggregate**, and `recordBlockBuzzSpend`
   can under-count on a Redis blip. Fix before wiring payouts + rate-card sign-off.

### Confirmed safe (security-specialist verification)
JWT verify (RS256 pinned, kid-scoped, iss/aud/exp/nbf/jti, strict claim typing, sub-overflow
bounded) · token mint (exact same-origin, scope intersection, anon fail-closed strip, rate
limits) · OAuth2/OIDC (PKCE-S256, redirect_uri exact-match, `appblk-` clients blocked from
the interactive flow) · KV datastore (no SQLi; schema-name sanitized + re-validated;
per-(block,user) isolation) · manifest SSRF gate · postMessage (origin + source-window
pinned) · webhook HMAC (timing-safe, raw body).
