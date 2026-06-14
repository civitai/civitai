# App Blocks — GA Burndown Handoff (2026-06-13)

Continuity doc for the App Blocks initiative. The **foundation is merged and live in
production, fully dark**; this session burned down several GA-blockers. This doc captures
what's done, what remains before GA (turning the flag on), the open decisions, and how to
proceed next session.

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

## Remaining GA-blockers (before turning the flag on)

From `app-blocks-merge-audit-2026-06.md`, still open:

- **MEDIUM — ZIP zip-bomb cap.** `publish-request.service.ts` fully decompresses each bundle
  entry before size-checking (no aggregate cap): ~2000 × 10 MiB ⇒ ~20 GiB from a 50 MiB upload →
  pod OOM. Mod-gated. Fix: running decompressed-byte ceiling. *(Recommended next.)*
- **MEDIUM — `submit-version` CSRF.** Prod session cookie is `sameSite:'none'` and `ModEndpoint`
  has no Origin check; Next.js parses urlencoded bodies, so a cross-site form POST with a tricked
  mod's cookie can submit a bundle. Pre-existing app-wide `ModEndpoint` posture; fix with an
  explicit same-origin/Origin check (ideally on `ModEndpoint`).
- **MEDIUM — per-user buzz cap.** `BLOCK_BUZZ_CAP_PER_DAY` is per-`(user, app_block)` (N blocks ⇒
  N× exposure) and the Redis counter under-counts on a blip. Make it a per-user aggregate.
- **Money — do NOT wire payouts** until rate-card sign-off + `internalAppOwnerUserIds` is
  populated. `mintPayoutForOwner` is a deliberate stub; keep it inert until then.

---

## Lower-priority / tracked follow-ups

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
3. Close the **MEDIUM GA-blockers** above.
4. Keep payouts inert until rate-card sign-off.
5. Configure the Flipt rollout deliberately (mod-segment → wider) — remember a *global* `enabled:
   true` exposes everyone (the H1 risk); widen via segments.

---

## How to proceed next session

- **Next GA-blocker: ZIP zip-bomb cap**, then `submit-version` CSRF, then per-user buzz cap.
- **Working pattern that converged well this session:** dispatch a subagent with
  `isolation: "worktree"` to implement (PR + tests), then dispatch read-only audit subagent(s)
  for *risks/regressions/leaks/second-order*; iterate until the audit converges (it took 2–4
  passes on the gnarly ones, e.g. the build-callback replay guard). Verify subagent claims
  directly — several were wrong on first pass (e.g. a flag-eval that "worked" only by luck, a
  redis return-value misread). Run tests via a `node_modules` symlink in the worktree
  (`ln -s /home/zach/workspace/civit/civitai/node_modules ./node_modules`); full `tsc` is
  unreliable in worktrees (stale Prisma) — CI is authoritative.
- Each PR: `gh pr create --base main`, stack independently on `main`.

## Key files
- **Flag gates:** `src/server/services/app-blocks-flag.ts`, `feature-flags.service.ts`
  (`buildFliptContext`), `enforceAppBlocksFlag` in `blocks.router.ts` / `apps.router.ts`.
- **Showcase:** `src/server/services/blocks/showcase.service.ts`.
- **Iframe payload:** `src/components/AppBlocks/IframeHost.tsx`, `projectBlockInit.ts`.
- **Publish/build pipeline:** `src/pages/api/internal/blocks/{git-push,build-callback,workflow-completed}.ts`,
  `src/server/services/blocks/{publish-request,apps-pipeline,forgejo}.service.ts`.
- **Bundle upload:** `src/pages/api/blocks/submit-version.ts`.
- **Buzz/money:** `src/server/services/blocks/buzz-attribution.service.ts`, `rate-card.ts`,
  `blocks.router.ts` (`BLOCK_BUZZ_CAP_PER_DAY`).
- **Tracking:** `docs/features/app-blocks-merge-audit-2026-06.md`.
