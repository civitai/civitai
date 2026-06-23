# App Blocks — GA Burndown Handoff (updated 2026-06-14)

Continuity doc for the App Blocks initiative. The **foundation is merged and live in
production, fully dark**. The 2026-06-13 session burned down the security GA-blockers; the
2026-06-14 session closed the **three remaining code GA-blockers** (zip-bomb cap,
submit-version CSRF, per-user buzz cap). This doc captures what's done, what remains before
GA (turning the flag on), the open decisions, and how to proceed next session.

**Companion docs:**
- `docs/features/app-blocks-merge-audit-2026-06.md` — the canonical audit + GA-blocker list (read this).
- `datapacket-talos/claudedocs/hpa-failedgetresourcemetric-node-pressure-handoff-2026-06-13.md` — infra hand-off.

---

## Current state

**Shipped & merged to `main` (all deployed, behind the dark flag):**
| PR | What |
|----|------|
| #2319 | App Blocks v1 foundation (block-host substrate, CORS, JWT, publisher-install, `model.sidebar_top`) |
| #2510 | `build-callback` webhook: flag-gate + atomic replay guard (`setNxKeepTtlWithEx`) |
| #2517 | Showcase images gated by viewer browsing level; **anon → public (PG)** |
| #2519 | **H2** — server/client flag-gate context unified (`buildFliptContext`) |
| #2521 | `BLOCK_INIT` payload minimized to an allowlist; `viewer.status` dropped |
| #2524 | `git-push` no longer auto-approves/deploys — gated behind moderator review |
| #2528 | **ZIP zip-bomb cap** — streaming per-entry decompression + running aggregate ceiling |
| #2529 | **submit-version CSRF** — shared same-origin allowlist applied to the raw route |
| #2530 | **per-user buzz cap** — per-user-per-day aggregate via atomic reserve-and-refund |
| #2532 | test-only typecheck fix (a pre-existing red `main` was failing every PR's preview) |

All shipped in release **5.0.1830**. The three GA-blocker PRs are **code/Redis-only — no new DB
migrations to hand-apply.**

**Flag state (verified against live Flipt GitOps `civitai/flipt-state`):** `app-blocks-enabled`
= base `enabled: false` + a `moderators` segment (`isModerator == "true"`). So the feature is
**off for everyone; on for moderators only** once the per-user gate matches.

**Key invariants now in place:**
- **No-widening (verified):** user-facing server gates evaluate Flipt with the request user's
  context via `buildFliptContext`; only `isModerator==true` (server-side) resolves TRUE. Non-mod
  / anon → false. Eval-cache keys on identity, so a mod's TRUE can't be replayed to a non-mod.
- **Machine/pipeline gates stay on the GLOBAL flag eval** (webhooks, JWKS, `withBlockScope`):
  they have no user context, so the **build/publish pipeline still requires a global enable** —
  intentional, pending a dedicated `app-blocks-pipeline-enabled` flag (see Decisions).
- **No trust-on-push:** `git-push` never deploys; the build/deploy is triggered only by
  `approveRequest` (the moderator path). Unreviewed pushes become `pending` review (202).
- Showcase + `BLOCK_INIT` no longer leak NSFW content/prompts/PII/moderation-state to the
  third-party iframe.
- **Bundle ingest is OOM-safe:** `extractBundleMetadata` streams each ZIP entry
  (`entry.nodeStream`) and aborts the moment a per-file (10 MiB) or running-aggregate
  (`MAX_TOTAL_DECOMPRESSED_BYTES` = 200 MiB) cap is exceeded — resident memory is bounded to
  ~one per-file cap regardless of compression ratio. Same helper guards the review-push and
  approve-fetch loops.
- **submit-version is CSRF-safe:** the raw `ModEndpoint` route (which bypasses tRPC's
  same-origin check; prod cookie is `sameSite:'none'`) now calls the shared
  `isAllowedOriginRequest` and 403s cross-origin POSTs in prod.
- **Buzz cap is a per-USER-per-day aggregate** (not per-`(user, app_block)`), enforced by an
  atomic INCRBY reservation at the gate with a DECRBY refund on over-cap / pre-resolve throw.
  Closes both the N-blocks × cap multiplication and the old read→record TOCTOU/under-count;
  fails closed on Redis loss; a lost refund over-counts (stricter, safe). The refund is pinned
  to the reserved key so a midnight-UTC rollover can't decrement the next day's key.

---

## GA-blockers — status

**DONE this session (merged, deployed dark):**
- ✅ **ZIP zip-bomb cap** (#2528).
- ✅ **submit-version CSRF** (#2529).
- ✅ **per-user buzz cap** (#2530).

**STILL OPEN before GA:**
- **Money — do NOT wire payouts** until rate-card sign-off + `internalAppOwnerUserIds` is
  populated. `mintPayoutForOwner` is a deliberate stub; keep it inert until then. The per-user
  buzz cap (#2530) was the spend-side prerequisite and is now in place.

---

## Open decisions (need a product/eng call before/around GA)

1. **Pipeline gate** — build a dedicated **`app-blocks-pipeline-enabled`** global Flipt flag for
   the machine endpoints (webhooks/JWKS), vs. globally enabling the user flag. The internal
   webhooks can't evaluate the mod-segmented user flag (no user context), so the pipeline is
   currently dark until one of these is decided.
2. **`git-push` update path** — is **`submitVersion` (ZIP upload → mod approve → deploy)** the
   canonical block-update path (making `git-push` purely a review-trigger), OR build the
   **"approve-from-repo"** path so `git-push`-recorded pending rows are deployable? Today a
   `git-push`-recorded pending row can't be approved by `approveRequest` (it has no MinIO ZIP
   bundle — it points at the Forgejo repo). Security holds either way (nothing unreviewed deploys).
3. **`viewer.status` removed from the `BLOCK_INIT` contract** — confirm with the
   `@civitai/app-sdk` / blocks-react owner (pre-GA, no external blocks, so safe to remove now).
4. **`withBlockScope` left on the global eval** — if mod dogfooding of *installed* blocks needs
   the per-user path (via the verified-JWT subject), that's a follow-up.

---

## Lower-priority / tracked follow-ups

**New (from the #2528–2530 adversarial audits):**
- **Wildcard-set zip-bomb (separate feature).** `src/server/services/wildcard-set-provisioning.service.ts:260`
  uses `entry.async('uint8array')` on user-uploaded ZIPs; it's only mitigated by an
  announced-uncompressed-size pre-sum cap, which trusts the attacker-controlled ZIP central
  directory (a lying entry can still OOM). Apply the same streaming-cap pattern as #2528. Lower
  risk than App Blocks was, but real.
- **Other cookie-auth POST routes still bypass the CSRF check.** #2529 was deliberately
  route-scoped. Other state-changing `ModEndpoint`/`AuthedEndpoint` POST/PUT routes that bypass
  `createContext`'s same-origin check include (HTTP method verified): `mod/set-image-nsfw-level`,
  `mod/csam-upload`, `mod/clavata-image-process`, `mod/scanner-policies/export-dataset`,
  `mod/new-order/rate-limit-config` (PUT), `admin/manage-sanity-checks`,
  `admin/temp/membership-buzz-backfill`. One-place fix: add
  `if (isProd && !isAllowedOriginRequest(req)) return 403` to `ModEndpoint`/`AuthedEndpoint` in
  `endpoint-helpers.ts` with a bearer/API-key exemption mirroring `createContext`. (GET-with-
  side-effects routes like `auth/impersonate` are a separate, non-Origin-allowlist concern.)
- **Buzz-cap LOWs (non-blocking):** the over-cap error's "already spent" value can momentarily
  overstate under concurrency (display only); `decrBy` lacks the templated-key typing `incrBy`
  has (cosmetic).

**Showcase LOWs (fail-safe):**
- `take:50`-then-JS-filter starvation: a SFW viewer can get an under-filled showcase on an
  NSFW-heavy model. Fix: filter `nsfwLevel` in-query (`$queryRaw` bitwise) or raise `take`.
- Double-gate divergence: the service re-derives the browsing level instead of trusting the
  already-`applyDomainFeature`-capped `input.browsingLevel`. Consider trusting the input, keeping
  the `userId`-null force as defense-in-depth.
- Dead code: `viewerStatus` is now computed-then-discarded in `ModelVersionDetails.tsx` (it's no
  longer forwarded). Optional cleanup of the producer computation + the `ModelSlotContext` field.

**Infra (need cluster write access — see the datapacket-talos handoff doc):**
- HPA `FailedGetResourceMetric`: node pressure on `talos-uvh-ow7` (over the 110-pod cap) and
  Tekton completed-pod bloat on `talos-x3r-mnv`; the `pipelinerun-pruner` was recently un-broken —
  confirm it's draining the backlog.
- `workflow-completed.ts` still uses the non-atomic `incrBy`+`expire` dedup (the same wedge class
  fixed in `build-callback`) — align it to `setNxKeepTtlWithEx`.
- `build-callback` durable cross-window replay protection needs a Tekton-side signed
  timestamp/nonce (the in-handler guard is a short-window backstop).

---

## Pre-GA checklist (when you flip the flag on)

1. Run the **`kill_per_model_installs` migration pre-flight per environment** (the join-count must
   be 0 — query is in the audit doc) and confirm all app-blocks migrations are applied.
2. Resolve **Decision 1 (pipeline gate)** and **Decision 2 (git-push update path)**.
3. ~~Close the MEDIUM GA-blockers~~ — **done** (#2528/#2529/#2530).
4. Keep payouts inert until rate-card sign-off.
5. Configure the Flipt rollout deliberately (mod-segment → wider) — remember a *global* `enabled:
   true` exposes everyone (the H1 risk); widen via segments.

---

## How to proceed next session

- **The code GA-blocker queue is clear.** Remaining GA work is the **open decisions** (pipeline
  gate, git-push update path), the **payout/rate-card** sign-off, and the **flag rollout** itself
  — these are product/eng calls, not code tasks. The lower-priority follow-ups above are
  opportunistic.
- **Working pattern that converged well:** dispatch a subagent with `isolation: "worktree"` to
  implement (PR + tests), then dispatch read-only audit subagent(s) for
  *risks/regressions/leaks/second-order*; iterate until the audit converges. **Run a SECOND
  audit round against the post-fix state** — this session's 2nd round caught a regression a fix
  had introduced (a `stream.destroy()` "polish" that failed CI typecheck and didn't even work,
  reverted to `pause()`).
- **Verify subagent claims directly — several were wrong on first pass** (a flag-eval that
  "worked" only by luck; a redis return-value misread; an audit citing a GET-only route as a
  POST-CSRF hole; an audit citing the wrong file path for a real finding).
- **Tests in a worktree:** `ln -s /home/zach/workspace/civit/civitai/node_modules ./node_modules`,
  then run the single target file. Full `tsc` in a worktree is noisy (stale Prisma client in
  unrelated files) — but you CAN validate a specific file with
  `npx tsc --noEmit -p tsconfig.json 2>&1 | grep <file>` (the stale-Prisma errors are in OTHER
  files; CI generates a fresh client). **Do not trust vitest-green alone** — esbuild strips
  types, so a real type error (e.g. a method not on the declared interface) passes vitest but
  fails CI's `tsc`. CI is authoritative.
- **If PR previews fail across unrelated PRs, suspect a red `main` first:** the Tekton
  `preview / deploy` is gated on Type Check, so one pre-existing typecheck error on `main` fails
  EVERY PR's preview. `gh pr checks <pr>` → look at Type Check before assuming it's your change.
- **No stacked PRs** (see CLAUDE.md): base every PR directly on `main`; if a change depends on an
  unmerged fix, wait for it to merge then merge `main` in (or fold into one PR).

## Key files
- **Flag gates:** `src/server/services/app-blocks-flag.ts`, `feature-flags.service.ts`
  (`buildFliptContext`), `enforceAppBlocksFlag` in `blocks.router.ts` / `apps.router.ts`.
- **Showcase:** `src/server/services/blocks/showcase.service.ts`.
- **Iframe payload:** `src/components/AppBlocks/IframeHost.tsx`, `projectBlockInit.ts`.
- **Publish/build pipeline:** `src/pages/api/internal/blocks/{git-push,build-callback,workflow-completed}.ts`,
  `src/server/services/blocks/{publish-request,apps-pipeline,forgejo}.service.ts`.
- **Bundle upload + CSRF:** `src/pages/api/blocks/submit-version.ts`, `src/server/utils/origin-helpers.ts`
  (shared same-origin allowlist, used by `createContext` and the route).
- **Buzz/money:** `src/server/services/blocks/buzz-attribution.service.ts`, `rate-card.ts`,
  `blocks.router.ts` (`BLOCK_BUZZ_CAP_PER_DAY`, `reserveBlockBuzzSpend`/`refundBlockBuzzSpend`).
- **Tracking:** `docs/features/app-blocks-merge-audit-2026-06.md`.
