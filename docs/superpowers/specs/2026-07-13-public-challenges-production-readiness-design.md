# Public Challenges — Production Readiness

- **Date:** 2026-07-13
- **Branch:** `feat/public-challenges`
- **Status:** Design — pending review
- **Feature flags:** `challengePlatform` (`challenge-platform-enabled`), `userChallenges` (`user-challenges`)

## Problem

We are opening challenge creation to normal (untrusted) users. The system was built for **system-created daily challenges**: one challenge at a time, trusted CivBot content, no money from users. Opening it to the public breaks three assumptions:

1. **Volume** — jobs were written for ~1 active challenge. They do not scale to hundreds of concurrent user challenges (silent drops, sequential LLM loops, unbounded queries).
2. **Money** — users now pay entry fees and fund prize pools. A few edge cases leak or mishandle buzz.
3. **Untrusted input** — user-supplied cover images, themes, and text need moderation gating and abuse controls that trusted CivBot content never needed.

This spec fixes those, ordered **Critical → Important → Minor**, to reach production readiness.

## Locked decisions

From review on 2026-07-13:

| Decision | Choice | Effect on scope |
|---|---|---|
| Judging cost ceiling | **Self-funded by the house cut** — review every paid entry; house cut must cover review cost | Verify + track economics, not a review cap |
| Partial-winner residual (<3 valid winners) | **Keep in house** | No redistribution/refund; formalize the existing account-0 retention |
| Live-challenge takedown | **Void only** (existing) | No new hide/freeze state — dropped from scope |
| House cut on mod-void | **Always non-refundable** | No change — dropped from scope |
| LLM NSFW auto-classification | **Dropped** | Out of scope |
| Prompt Lab | **Dropped** | Out of scope |

## Scope

**In:** job scalability, house-cut economics + spend tracking, off-resource fee leak, cover-image scan gate, Redis singleton correctness, entrant refund notification, and a set of minor hardening items.

**Out:** hide/freeze moderation states, house-cut refunds, LLM NSFW classification, Prompt Lab, leaderboards/streaks/UserChallengeStats (Phase 4 polish, not launch-blocking).

---

# CRITICAL

These block a correct public launch. Without them the system silently drops challenges, times out, or mishandles buzz at volume.

## C1. Job scalability

### Current state
Four cron jobs drive challenges. Written assuming ~1 active challenge:

- `daily-challenge-process-entries` (`*/10 * * * *`) → `reviewEntries` → `getActiveChallenges()` loop (`daily-challenge-processing.ts:540-564`).
- `challenge-activation` (`0 * * * *`) → void-unscanned + activate-ready (`challenge-activation.ts`).
- `challenge-completion` (`0 * * * *`) → pick-winners + reconcile (`challenge-completion.ts`).
- `daily-challenge-setup` (`0 22 * * *`) / `challenge-auto-queue` (`0 6 * * *`) — System-only creation, not volume-sensitive.

Defects at volume:

1. **Silent drop.** `getActiveChallengesFromDb` has `LIMIT 50` (`challenge-helpers.ts:221`). The 51st+ active challenge is never reviewed — its entries are never judged. **Correctness bug**, not perf.
2. **Sequential LLM loops.** Completion winner-pick (`for...of`, one `generateWinners` per ended challenge, `challenge-completion.ts:32`) and review (`daily-challenge-processing.ts:558`) have no `limitConcurrency`. Hundreds ending at the top of the hour → hundreds of serial LLM calls in one hourly run → exceeds the 5-min job lock (`job.ts:103`) and the HTTP job timeout; tail challenges starve until the next tick.
3. **Unbounded selectors + N+1.** `getEndedActiveChallengesFromDb`, `getScheduledChallengesReadyToStart`, `getChallengesToReconcileFromDb`, `getUnscannedUserChallengesPastStart` have no LIMIT; each then does `Promise.all(rows.map(getChallengeById))` and every `getChallengeById` runs 4 correlated cover-image subqueries (`challenge-helpers.ts:142-145`). 500 ended challenges ≈ 2500 queries just to load them.

### Design

**Process all, bounded per run, concurrently:**

- **Remove the `LIMIT 50` silent cap.** Replace with cursor/batch pagination so every active challenge is processed across the run — no challenge is silently skipped. If a single run cannot drain the backlog, it must drain deterministically across consecutive runs (ordered cursor), not truncate.
- **Add `limitConcurrency`** (`~/server/utils/concurrency-helpers`) to the per-challenge loops in review, completion (winner-pick), activation, and reconcile. Start at a conservative cap (e.g. `CHALLENGE_JOB_CONCURRENCY = 5`) as a constant so it is tunable. Concurrency is bounded by both DB load and LLM rate limits — pick a cap that respects OpenRouter limits.
- **Batch-load challenges.** Replace the per-row `getChallengeById` fan-out with a single set-based query that loads N challenges + their cover-image data in one round trip (lateral join or a batched selector). Kills the N+1.
- **Bound each run.** Each selector takes a `LIMIT` (batch size, e.g. 200) + stable `ORDER BY` (e.g. `endsAt ASC`, `startsAt ASC`). Remaining work rolls to the next tick. Log when a run hits its batch ceiling so silent truncation is visible (`logToAxiom`).

**Re-entrancy / lock safety:**

- Completion is already claim-guarded (`claimChallengeForCompletion` atomic `Active→Completing`, `challenge-helpers.ts:713`). Keep it.
- Review and activation are not claim-guarded. With bounded batches + concurrency the per-run duration stays under the 5-min lock, but add idempotency guards where a second overlapping tick could double-act:
  - Review already has the `notYetReviewedByJudge` recheck before spending an LLM call (`daily-challenge-processing.ts:922-932`) — keep it as the dedup backstop.
  - Activation: `setChallengeActive` should be a conditional write (`updateMany where status = 'Scheduled'`) so a double-activation is a no-op.

### Files
- `src/server/games/daily-challenge/challenge-helpers.ts` — selectors (add LIMIT + ORDER BY), batched loader, conditional activation write.
- `src/server/jobs/challenge-completion.ts`, `challenge-activation.ts` — `limitConcurrency`, batch ceiling logging.
- `src/server/jobs/daily-challenge-processing.ts` — `reviewEntries` loop concurrency, drop `LIMIT 50` reliance.
- `src/shared/constants/challenge.constants.ts` — `CHALLENGE_JOB_CONCURRENCY`, `CHALLENGE_JOB_BATCH_SIZE`.

### Risks
- Concurrency vs OpenRouter rate limits — cap conservatively, make it a constant, watch Axiom.
- Cursor pagination must be stable under concurrent status transitions; order by an immutable key (id or endsAt) and re-filter status in the query.

## C2. House-cut economics + spend tracking

### Current state
Paid user challenges review **every** entry (`judgeAllEntries`, `daily-challenge-processing.ts:867`) and there is **no cost accounting** — `operationBudget`, `operationSpent`, `reviewPercentage`, `maxReviews`, `reviewCost`, `reviewCostType` columns exist in `Challenge` but are read/written **nowhere** (0 code references). Dead scaffolding from the original creator-escrow design.

### Cost calibration (verified 2026-07-13, OpenRouter)

Buzz rate: `buzzDollarRatio = 1000` → 1 Buzz = $0.001. House cut = `CHALLENGE_ENTRY_HOUSE_CUT = 25` Buzz = **$0.025/entry**.

| Model | Use | Input $/M | Output $/M |
|---|---|---|---|
| `openai/gpt-5-nano` | per-entry review | 0.05 | 0.40 |
| `openai/gpt-4o-mini` | winner-pick + content | 0.15 | 0.60 |

- **Per-entry review** (gpt-5-nano, ~4–5k input incl. 1 vision image, ~300–500 output) ≈ **$0.0004–0.0005 ≈ 0.5 Buzz**. House cut 25 Buzz ⇒ **~50× margin**. Comfortably self-funding.
- **Winner-pick** (gpt-4o-mini, top-10 images, once/challenge). gpt-4o-mini's vision token multiplier makes 10 full-detail images the dominant cost ≈ **$0.02–0.04 ≈ 20–40 Buzz per challenge, one-time**. Covered by aggregate house cut for any challenge with ≥2 paid entries.

**Conclusion: the 25-Buzz house cut is already economically sound. No fee/constant increase needed for solvency.** The risks are (a) not measuring real spend, (b) the winner-pick vision cost being needlessly high, and (c) the degenerate 1-entrant challenge where one-time winner-pick cost > 25 Buzz collected.

### Design

1. **Track real spend.** Return token usage from `pickClient`/`generateReview`/`generateWinners` (OpenRouter responses include `usage`), convert to Buzz via the known model rates, and accumulate into `Challenge.operationSpent` (atomic increment) per challenge. Emit an Axiom metric `challenge-llm-spend` with `{challengeId, source, reviewSpent, winnerSpent, houseCutCollected}` so we watch spend-vs-revenue in prod. This makes the "self-funding" claim continuously verifiable instead of assumed.
2. **Cheapen the winner-pick vision.** The 20–40 Buzz driver is gpt-4o-mini vision over 10 full images. Options, in order of preference:
   - Send `detail: 'low'` (flat ~85 vision tokens/image) for the winner-pick shortlist, or send a smaller CDN rendition. Collapses winner-pick to ~1–2 Buzz. Validate judging quality is preserved on a low-detail shortlist (the shortlist is already scored; winner-pick is a tiebreak/narrative step).
   - Or route winner-pick through gpt-5-nano vision (much cheaper per image).
3. **Guard the degenerate case.** When a paid challenge has **< 2 distinct entrants**, skip the LLM winner-pick entirely (no meaningful competition) — the existing zero/degenerate paths already handle awarding/refunding. Prevents paying 20–40 Buzz to pick a "winner" out of one entry funded by a single 25-Buzz cut.
4. **Keep the constants.** `CHALLENGE_ENTRY_HOUSE_CUT = 25`, `CHALLENGE_MIN_ENTRY_FEE = 50` stay. Document the measured margin next to the constants so future changes are made with the economics in view.

**Not doing:** review caps / `reviewPercentage` / `operationBudget` escrow. Decision is to review every paid entry, self-funded. `operationSpent` is used for **observability only**, not enforcement. (`reviewCost`/`reviewCostType` belong to the separate paid-manual-review feature and are untouched.)

### Files
- `src/server/services/ai/openrouter.ts` — surface `usage` from responses.
- `src/server/games/daily-challenge/generative-content.ts` — capture usage; winner-pick image `detail`/rendition.
- `src/server/games/daily-challenge/daily-challenge-processing.ts` — accumulate `operationSpent`, degenerate-case guard, Axiom metric.
- `src/shared/constants/challenge.constants.ts` — documented margin; a `CHALLENGE_REVIEW_BUZZ_ESTIMATE` for the metric.

### Risks
- Low-detail winner images could change winner quality — A/B on a sample before flipping; keep full detail for the per-entry review scoring (that's the accuracy-critical pass and it's cheap on gpt-5-nano).
- OpenRouter prices change — the Axiom metric is the early-warning; constants documented, not hardcoded into logic.

---

# IMPORTANT

Real money leaks / correctness-for-users / trust issues. Not silent-fatal like the Critical set, but must ship before a wide launch.

## I1. Off-resource entry fee leak

**Problem.** `modelVersionIds` is enforced at **promotion/review** time (`challenge-rewards.ts:38-66`), not at submit. A user can submit an image that doesn't use the required resource, get **charged the entry fee** (`validateContestCollectionEntry:2197-2215`), then have the entry **auto-REJECTED and hard-deleted** — the entry fee is **never refunded** (only paid manual-review purchases refund on reject). User pays for an entry the system silently kills.

**Design.** Validate the resource requirement at **submit time**, before charging: in `validateContestCollectionEntry`, when the challenge has non-empty `modelVersionIds`, check `EXISTS ImageResourceNew WHERE imageId = ? AND modelVersionId = ANY(?)` and reject the submission (no charge) if it fails. This mirrors the existing NSFW/window checks that already gate before the fee charge. No refund path needed because no charge happens.

**Files.** `src/server/services/collection.service.ts` (`validateContestCollectionEntry`). Reuse the promotion query shape from `challenge-rewards.ts`.

**Risk.** Adds one `EXISTS` query per submit for resource-restricted challenges — acceptable (submit is not hot-loop). Keep the promotion-time check too as defense-in-depth.

## I2. Cover-image scan gate before publish

**Problem.** Publish/visibility gates on the challenge require **text** `ingestion = 'Scanned'`, but the **cover image** is only gated by `coverImageId NOT NULL` + POI (`challenge.service.ts:388-396`). Text-scan and image-scan are decoupled: a challenge can go visible with an un-scanned or mid-scan cover image.

**Design.** Require the cover image to have completed image moderation (`Image.ingestion = 'Scanned'` / `scannedAt IS NOT NULL`, plus not `Blocked`) before the challenge is publicly visible. Add the join/condition to the feed + detail visibility queries (non-creator branch), matching the existing text-scan gate. Creator still sees their own pre-scan.

**Files.** `src/server/services/challenge.service.ts` (feed `getInfiniteChallenges`, detail `getChallengeDetail` visibility SQL), `challenge-visibility.ts` if a shared helper fits.

**Risk.** Slightly delays first-visibility until the cover image scan completes — correct behavior, matches the text-scan model. Ensure the activation job's user-challenge gate (`source != 'User' OR ingestion = 'Scanned'`) accounts for cover-scan state too, so an activated challenge isn't visible-blocked immediately after start.

## I3. Entrant refund notification on void

**Problem.** `voidChallenge` refunds entrants' pool contributions but emits **zero notifications** (`challenge.service.ts:2256-2295`). Entrants who paid into a challenge learn it was cancelled only by noticing a buzz transaction. Trust gap for a paid, public system.

**Design.** Add a `challenge-cancelled` notification (registry `challenge.notifications.ts`) sent to every distinct entrant on `voidChallenge` (and the zero-winner refund path), stating the challenge was cancelled and the pool portion refunded (house cut retained, per locked decision — message should be honest about that). Optionally a `challenge-refunded` variant for the creator's escrow refund on delete. Keep `toggleable: false` like the others.

**Files.** `src/server/notifications/challenge.notifications.ts` (new type), `challenge.service.ts` (`voidChallenge`, `endChallengeAndPickWinners` zero-winner branch, `refundUserChallengeFunds` callers).

**Risk.** Fan-out notification on large challenges — batch the insert (existing notification helpers support bulk).

## I4. Redis / DB "current challenge" singletons

**Problem.** Multi-challenge breaks singleton assumptions:
- `REDIS_KEYS.DAILY_CHALLENGE.DETAILS` is **overwritten** by whichever challenge activated last (`setChallengeActive`, `challenge-helpers.ts:479-484`) — last-writer-wins, meaningless with many active.
- `getCurrentChallenge`/`getActiveChallengeFromDb` are `LIMIT 1 ORDER BY startsAt DESC` (`daily-challenge.utils.ts:513`, `challenge-helpers.ts:205`); consumers (`services/daily-challenge.service.ts:61` deprecated `getCurrentDailyChallenge`, `pages/api/mod/daily-challenge/cycle.ts:35`) silently see only the newest active challenge.

**Design.** Two parts:
- **`DETAILS` key:** either namespace it per challenge (`daily-challenge:details:{id}`) if any live consumer needs it, or retire the write if nothing reads it meaningfully. Audit readers first; prefer retiring dead writes over adding per-id keys nobody reads.
- **Singleton consumers:** the deprecated `getCurrentDailyChallenge` and the mod `cycle.ts` endpoint are legacy daily-challenge paths. Confirm they are not on any public user-challenge path; if they are strictly legacy/mod-daily, leave with a comment; if reachable for user challenges, replace with an explicit challenge-id lookup.

**Files.** `challenge-helpers.ts`, `daily-challenge.utils.ts`, `services/daily-challenge.service.ts`, `pages/api/mod/daily-challenge/cycle.ts`, redis key defs in `packages/civitai-redis`.

**Risk.** Low — mostly retiring/namespacing dead singletons. The audit (who reads `DETAILS`) must be done first.

---

# MINOR

Hardening and polish. Ship after Critical + Important; none block a gated launch.

- **M1. Create-frequency rate limit.** Only a concurrent cap exists (`assertUnderActiveChallengeLimit`); Scheduled+zero-entry challenges refund fully on delete → free create→delete churn (spam / scan-queue load) is unthrottled. Add a per-user create rate limit (e.g. N/day) in `assertCanCreateUserChallenge`.
- **M2. Scan the `invitation` field.** Validated (`max 300`) but excluded from `buildChallengeModerationText` (title/theme/description only). Add it to the moderation text.
- **M3. Re-check creator eligibility on edit.** Standing/score gate runs only on create (`!id` branch). A since-muted/struck user can still edit a Scheduled challenge. Re-run `assertUserInGoodStanding` on edit.
- **M4. Challenge report reasons.** `ReportEntity.Challenge` offers only AdminAttention/NSFW/Spam. Add an ownership/impersonation reason — cover images and themes are user-supplied.
- **M5. Winner-mapping hardening.** Winner selection maps LLM output by `creator`/`creatorId` string (`daily-challenge-processing.ts:1301-1305`); mitigated by the injection preamble but names are user-controlled. Prefer mapping the LLM's chosen entry back by **entry/image id** rather than creator name (defense-in-depth).
- **M6. Partial-winner residual — formalize.** Decision is keep-in-house; the buzz already sits in account 0 (the house). Downgrade the `challenge-partial-winner-residual` log from a warning to an info/metric so it reads as intended behavior, not an anomaly.

---

# Production readiness

- **Feature gating.** All changes stay behind `challengePlatform` + `userChallenges`. No new flag needed; the launch flag is `userChallenges`.
- **DB migrations.** No new columns required (we reuse the existing dead `operationSpent`). If any index is needed for bounded selectors (e.g. covering `status, endsAt`), write the SQL, commit it under `prisma/migrations/`, and surface it for **manual apply** (we do not run `prisma migrate deploy`). Existing `@@index([status, endsAt])` / `([status, startsAt])` already cover the main selectors — verify before adding.
- **Monitoring.** New Axiom signals: `challenge-llm-spend` (C2), job batch-ceiling-hit warnings (C1), void/refund notification counts (I3). Add a dashboard for spend-vs-house-cut and job run duration vs lock.
- **Testing.**
  - Unit: bounded selectors return ≤ batch size + stable order; `limitConcurrency` caps in-flight; degenerate-entrant guard skips winner-pick; off-resource submit is rejected pre-charge; cover-scan gate hides un-scanned covers; spend accumulation math.
  - Integration/job: seed N (e.g. 120) concurrent active + ended challenges; assert none dropped, run stays under lock, one failure isolates.
  - Money: void → entrants refunded (pool only) + notified; partial-winner buzz stays in house; no double-refund on concurrent void/delete (ledger idempotency).
  - Follow repo rule: job/handler tests live outside `src/pages` (e.g. `src/server/**/__tests__`), Vitest.
- **Rollout.** Ship Critical first (behind flag, on a small allowlist / low tier cap), watch the spend + job-duration dashboards, then Important, then Minor, then widen `userChallenges` availability.

## Phasing (maps to the plan)

1. **Phase 1 — Critical:** C1 job scalability, C2 economics + spend tracking. Gate wide-launch on these.
2. **Phase 2 — Important:** I1 off-resource fee, I2 cover-scan gate, I3 refund notification, I4 singletons.
3. **Phase 3 — Minor:** M1–M6.

Each phase is independently shippable behind the existing flags.

## Open questions

- **I4 audit:** who actually reads `REDIS_KEYS.DAILY_CHALLENGE.DETAILS` today? Determines namespace-vs-retire. (Resolve during Phase 2.)
- **C2 winner-pick quality:** does low-detail (or gpt-5-nano) winner-pick preserve winner quality vs full-detail gpt-4o-mini? Validate on a sample before flipping.
