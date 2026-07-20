# Challenge Platform

Canonical reference for how Civitai's challenge platform works: automated daily/system challenges,
moderator-created challenges, and user-created ("public") challenges, all AI-judged. This is the
single source of truth — it supersedes the former `daily-challenge.md`,
`dynamic-challenge-judging-categories.md`, `dynamic-judging-categories-plan.md`,
`challenge-design-questions.md`, and the public/user-challenge plan+spec docs.

Anything not yet live is tagged **(deferred)**.

---

## 1. Overview

A challenge is a time-boxed, AI-judged creative contest around one or more community models.
Challenges live in the `Challenge` table; entries are `CollectionItem` rows in each challenge's
Contest-mode collection. An LLM (via the Civitai LLM client) generates challenge content and scores
entries/winners.

`Challenge.source` (`ChallengeSource` enum) determines origin and behavior:

| Source | Origin | Judging | Funding |
|---|---|---|---|
| `System` | AI-generated daily challenges (cron) | Fixed daily rubric (unless dynamic-judging flag on) | Platform prizes |
| `Mod` | Moderator-created | Fixed rubric (unless dynamic-judging flag on) | Mod-configured |
| `User` | User-created ("public") | Creator-defined **weighted categories** | **Entry-fee funded** |

Two Flipt flags gate the surface:

- **`challenge-platform-enabled`** (feature flag `challengePlatform`) — the whole platform (router, page SSR, nav, job start).
- **`user-challenges`** (feature flag `userChallenges`) — user creation + management. **This is the flag rolled out to testers via segmented rollout.**

Judging is category-driven for **all** sources (no feature flag): any challenge that stores `judgingCategories` is judged by them; the rest fall back to the default four.

---

## 2. Architecture & key files

**Server**
- `src/server/jobs/daily-challenge-processing.ts` — challenge setup + `reviewEntries()` (entry validation + AI scoring), `getJudgedEntries` ranking, `startScheduledChallenge` activation.
- `src/server/jobs/challenge-auto-queue.ts` — `ensureChallengeHorizon()` (30-day pipeline).
- `src/server/jobs/challenge-activation.ts` — `runChallengeActivation()` (Scheduled → Active).
- `src/server/jobs/challenge-completion.ts` — `runChallengeCompletion()` (winner picking).
- `src/server/games/daily-challenge/generative-content.ts` — LLM content + review generation, rubric injection.
- `src/server/games/daily-challenge/daily-challenge.utils.ts` — `getChallengeConfig()`, state helpers.
- `src/server/games/daily-challenge/daily-challenge-scoring.ts` — weighted scoring utils.
- `src/server/games/daily-challenge/challenge-helpers.ts` — DB helpers, collection creation, winner management.
- `src/server/services/challenge-category.service.ts` — DB-backed category library + rubric resolution.
- `src/server/games/daily-challenge/challenge-funding.ts` / `challenge-pool.ts` — entry-fee charge/refund, pool math.
- `src/server/services/challenge.service.ts` — CRUD, mod actions, user procedures, detail assembly.
- `src/server/routers/challenge.router.ts` · `src/server/schema/challenge.schema.ts`.
- `src/shared/constants/challenge.constants.ts` — presets, keys, judge whitelist, economics constants.
- `src/server/flipt/client.ts` — flag keys.

**Client**
- `src/components/Challenge/ChallengeUpsertForm.tsx` (unified create/edit, `variant` prop), `CategoryWeights.tsx`, `ChallengeContextMenu.tsx`, `ChallengeSubmitModal.tsx`, `challenge.utils.ts`.
- `src/components/Cards/ChallengeCard.tsx`.
- `src/pages/challenges/index.tsx` (feed + "My Challenges"), `src/pages/challenges/[id]/[[...slug]].tsx` (detail), `src/pages/challenges/[id]/edit.tsx`, `src/pages/challenges/create.tsx`, `src/pages/moderator/challenges.tsx`.

**Config source**: `getChallengeConfig()` reads `REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG` from sysRedis with a code-default fallback (fail-open). LLM prompt text comes from the `ChallengeType` table; judge personas from `ChallengeJudge`.

**Debug**: `/api/testing/daily-challenge` (actions: `article`, `collection`, `review`, `winners`, `complete-review`, `complete-challenge`, `create-challenge`) — guarded by `WEBHOOK_TOKEN`.

---

## 3. Lifecycle & states

`ChallengeStatus`:

```
Scheduled → Active → Completing → Completed
    ↓          ↓
Cancelled   Cancelled
```

- **Scheduled** — funded, waiting for `startsAt`. The only state a user challenge may be edited/deleted in.
- **Active** — accepting submissions (between `startsAt` and `endsAt`).
- **Completing** — winner-picking in progress; guards against duplicate processing.
- **Completed** — winners announced (terminal).
- **Cancelled** — voided before completion (terminal); hidden from public, visible to mods.

Transitions are date/job-driven and enforced at the application layer only (no DB constraints).

**Scheduling / queue**
- Horizon = **30 days**; `challenge-auto-queue` tops up `System` challenges so it's always full. Mod/user challenges in the window count toward the total.
- Auto-created challenges are inserted directly as **Scheduled** (never Draft); the horizon query counts Scheduled only.
- **Unlimited concurrent active challenges** — jobs process each independently with per-challenge error isolation.
- `visibleAt` controls public feed appearance (default 7 days before `startsAt`; user challenges = `now()`).
- Active-challenge edits are restricted to non-competitive fields.

**Runtime jobs**

| Job | Schedule | Function |
|---|---|---|
| `daily-challenge-setup` | `0 22 * * *` (10 PM UTC) | `createUpcomingChallenge()` — AI-generate next system challenge (if none upcoming) |
| `challenge-auto-queue` | `0 6 * * *` (6 AM UTC) | `ensureChallengeHorizon()` — maintain 30-day horizon |
| `daily-challenge-process-entries` | `*/10 * * * *` | `reviewEntries()` — validate + AI-score across all active challenges |
| `challenge-activation` | `0 * * * *` (hourly) | `runChallengeActivation()` — Scheduled → Active at `startsAt` |
| `challenge-completion` | `0 * * * *` (hourly) | `runChallengeCompletion()` — pick winners past `endsAt` |

**Moderator quick actions** (replace manual status edits): Scheduled → *Cancel*; Active → *End & Pick Winners* / *Void*; terminal states → none. End/void/pick-winners is **moderator-only for all sources**, including user challenges ("mods own ending").

---

## 4. Entries, scoring & winner selection

**Entry validation** (`reviewEntries()`; failure → rejected):
1. **NSFW** — image `nsfwLevel` must satisfy the challenge's `allowedNsfwLevel` bitwise flag.
2. **Required resource** — image must use ≥1 of the challenge's `modelVersionIds` (via `ImageResourceNew.modelVersionId`, SQL `ANY()` OR-match).
3. **Recency** — image `createdAt` ≥ challenge `startsAt`.

**AI scoring** — each accepted entry is scored 0–10 per judging dimension. The LLM also returns a `reaction`, a `comment` (posted to the image), and a `summary`. Score/summary are stored on `CollectionItem.note`.

**Ranking**
- `System`/`Mod` (fixed rubric): `Rating = average(theme, wittiness, humor, aesthetic)`.
- `User` (weighted categories): `calculateWeightedCategoryScore` — see §6.

**Winner selection**: close collection → rank → dedup to each user's single best entry → send top `finalReviewAmount` (10) to the LLM for final winner selection with reasons → award winner prizes (yellow Buzz) → award entry-participation prizes (blue Buzz) → store `Challenge.metadata.completionSummary` (`{ judgingProcess, outcome, completedAt }`) → notify.

**Base prize structure** (`System`, from config):

| Place | Buzz | Points |
|---|---|---|
| 1st | 5,000 | 150 |
| 2nd | 2,500 | 100 |
| 3rd | 1,500 | 50 |

Participation prize: users with ≥ `entryPrizeRequirement` (10) valid entries get 200 Buzz + 10 points, awarded immediately on hitting the threshold (winners excluded), plus a completion sweep.

---

## 5. Judging system

### Judges (`ChallengeJudge`)
AI judge personas with custom prompts/bios. When `Challenge.judgeId` is set, the judge's profile is shown as the "creator" in feed + detail (**display-layer only** — `createdById` is unchanged, so owner checks must never use the displayed `createdBy.id`, which is `judgeUserId ?? createdById`). Selectable judges are a hardcoded whitelist, not a DB column.

### Dynamic judging categories (`ChallengeCategory`)
Judging is category-driven: a challenge's `judgingCategories` (a weighted mix from a curated library) determines which scoring rubrics the judge applies. Behavior-preserving by default — the default rows (`theme 50 / aesthetic 20 / humor 15 / wittiness 15`) rank identically to the old fixed weights; outcomes change only when categories/weights are reshaped.

**Library table `ChallengeCategory`** (structural migration `prisma/migrations/20260709201808_challenge_category_table`; edit `packages/civitai-db-schema/prisma/schema.full.prisma`, never the slim schema):

| Column | Purpose |
|---|---|
| `key` (PK) | stable id (`theme`, `aesthetic`, …) |
| `label` | picker display + sanitized score-JSON key |
| `criteria` | terse one-liner — **client-visible** |
| `rubric` | rich SFW scoring block — **server-only** |
| `rubricNsfw` | NSFW override; `null` → falls back to `rubric` |
| `group`, `sortOrder`, `active` | picker grouping/ordering/soft-hide |

Per-category **weights** live on the challenge instance (`Challenge.judgingCategories Json?`, rows of `{ key, weight, label, criteria }`), not in the library.

**Rubric resolution** (`pickCategoryRubric`, server): DB `rubricNsfw` (when nsfw) → DB `rubric` → text derived from `label`+`criteria`. `criteria` is the terse, client-visible one-liner; `rubric` is the detailed scoring guidance and is **not the same thing**. Rich rubric text lives **only in the DB**, never committed to the repo: the row structure + `criteria` are inserted by the committed structural migration, and the rich `rubric`/`rubricNsfw` are added by the gitignored seed (§9). An unseeded table degrades to the terse criteria-derived form, so **seeding is required** for full-quality judging. `getChallengeCategoryRows` caches the library for 5 min and **unions** the DB rows over the preset baseline (`mergeCategoryRows` — DB overrides/adds by `key`, presets fill the rest), so the mandatory presets (esp. `theme`) are structurally guaranteed regardless of table state; a missing table falls back to `presetFallbackRows()` (structure + criteria only). Because the union keeps the baseline present, persisting a single category (`upsertChallengeCategory`) is a plain upsert that can never orphan `theme`.

**Prompt injection** — the sentinel `{{SCORING_RUBRICS}}` (`SCORING_RUBRICS_SENTINEL`, `generative-content.ts`) sits in a judge's `reviewPrompt` where the rubric block goes:
- `injectRubrics(reviewPrompt, block)` replaces every sentinel occurrence; **if the sentinel is absent, the prompt is returned byte-for-byte unchanged** (unmigrated judges are unaffected — this is the backward-compat guarantee).
- `resolveRubricBlock(categories, { nsfw })` assembles the block from the selected categories.
- `buildFallbackMessages` (the live path) **always resolves the sentinel**: `effectiveCategories = input.categories?.length ? input.categories : DEFAULT_CATEGORY_ROWS`. So a null/empty-category challenge on a migrated judge renders the four pre-migration canonical blocks — never a literal `{{SCORING_RUBRICS}}` — while keeping the fixed `RESPONSE_SCHEMA`. A challenge with real categories gets those categories' rubrics + a category-keyed schema (`buildCategoryReviewSchema`).

Net invariants: (a) sentinel absent → identical to legacy; (b) sentinel present + null categories → default blocks + fixed schema; (c) sentinel present + real categories → category rubrics + category schema.

### Judge-prompt migration
The 3 SFW judges — **CivBot, CivChan, GigaBot** — have their baked `THEME/WITTINESS/HUMOR/AESTHETIC SCORING` blocks replaced by the single `{{SCORING_RUBRICS}}` sentinel (otherwise the model would see the rubric twice). The INTEGRITY-CHECK anti-cheat line moves into the always-present static prompt so it survives the strip. **CivChan NSFW is intentionally excluded** (the `rubricNsfw` set is incomplete in v1, so it stays on its baked blocks).

This is a **DB content change applied manually per environment** (retool/psql) — see §9. Rich rubric text lives only in the DB and the gitignored `scripts/migrations/*.local.sql`; it is never committed to the repo.

**Prod caveat**: until the sentinel migration is applied to an environment, that env's real judges lack the sentinel, so `injectRubrics` is a no-op and dynamic category selection is inert there (safe legacy behavior). Category rows can be seeded independently; they are dormant until the sentinel is present.

**Status**: category library + injection + default-rubric fallback + mod persistence/UI are **shipped**, and judging is category-driven for **all sources** — the `dynamic-judging-categories` flag was removed; any challenge that stores `judgingCategories` is judged by them, others fall back to the default four. Judge-prompt sentinel migration + rubric seed = human-applied per env, **required** (§9). Historical backfill and the NSFW rubric set are **(deferred)** — the default-rubric fallback makes backfill unnecessary for correctness.

---

## 6. Public / user-created challenges

Gated by `userChallenges`. Only `User`-source behavior below is new; `System`/`Mod` paths are untouched.

### Creation form
One component, `ChallengeUpsertForm`, with `variant?: 'moderator' | 'user'` (`isUser = variant === 'user'`). `UserChallengeUpsertForm` is a thin `<ChallengeUpsertForm variant="user" />` wrapper; create page `/challenges/create`.
- **Shared**: basics (title/theme/cover/description), schedule, prize distribution.
- **User-only**: entry-fee section (`entryFee`, `initialPrizeBuzz`, `dist1/2/3`), `<CategoryWeights />`, restricted judge picker, `InputContentRatingSelect` (browsing level), `source` forced to `User`. The judging-prompt override is hidden.
- **Mod-only** (hidden for users): source, event, eligible-models multiselect, fixed prize mode, paid-review budget.
- Submit: `isUser` → `upsertUserChallenge`; else → `upsert`.

### Weighted categories
Schema in `challenge.schema.ts`: each category `{ key ∈ CHALLENGE_CATEGORY_KEYS, label(1–50), criteria(1–500), weight(1–100) }`; array `.min(1).max(4)` with a `superRefine` requiring **exactly one `theme`** (mandatory), unique preset keys (`custom` may repeat), case-insensitive unique labels, and **weights summing to 100**. `CHALLENGE_CATEGORY_KEYS = ['theme','humor','wittiness','aesthetic','custom']`.

`CategoryWeights` UI: Theme row pre-selected and non-removable; up to 3 more; preset rows auto-fill read-only label/criteria; custom rows editable; per-row integer weight; live "must total 100%"; add disabled at 4. Editable only while **Scheduled + 0 entries**.

**Weighted scoring** (`daily-challenge-scoring.ts`, `calculateWeightedCategoryScore`, keyed by category **label**), theme always gated:
- `themeScore < 2` (`THEME_DISQUALIFY_THRESHOLD`) → `null` (disqualified).
- else weighted = `Σ clamp(score, 0, 10) * weight/100`.
- `themeScore < 4` (`THEME_GATE_THRESHOLD`) → cap result at `5.0` (`THEME_GATE_MAX_SCORE`).

### Selectable judges
User picker restricted to `USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan']` — keyed by **name** (not id/userId; ids differ per env, and `CivChan` shares a `userId` with `"CivChan NSFW"`, so a userId filter would leak the NSFW judge). `getActiveJudgeOptions` filters `{ active: true, name: { in: whitelist } }`; `upsertUserChallenge` re-validates the chosen judge resolves to an allowed name.

Review generation for `User` source routes through `buildCategoryReviewSchema` (one 0–10 score per category label). The job passes `categories: judgingCategories.map(c => ({ name: c.label, criteria: c.criteria }))` into `generateReview`; stored `score` is `Record<label, number>`. `getJudgedEntries` computes `weightedRating` in JS for `User`, drops `null`, best entry per user, sorts desc, slices to `finalReviewAmount`. Score consumers (`parseJudgeScore`, `JudgeScoreBadge`, `ReviewImageActivity`) tolerate category-keyed scores.

### Economics (entry-fee model)
Users fund challenges by an **entry fee** (no fixed prize mode). Hard invariant: **Buzz is never minted** — every pool/refund derives from actual charge transactions, never from row counts. Logic in `challenge-funding.ts` / `challenge-pool.ts`. Constants (`challenge.constants.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `CHALLENGE_ENTRY_HOUSE_CUT` | 25 | flat house cut per entry (rest reaches the pool) |
| `CHALLENGE_MIN_ENTRY_FEE` | 50 | minimum entry fee |
| `CHALLENGE_MAX_ENTRY_FEE` | 100,000 | maximum entry fee |
| `CHALLENGE_MIN_CREATOR_SCORE` | 5,000 | minimum creator score to create a challenge (eligibility gate) |
| `CHALLENGE_MAX_INITIAL_PRIZE` | 10,000,000 | cap on creator-seeded initial prize |

Idempotency-key prefixes: entry fee `challenge-entry-fee-${challengeId}-${imageId}`, initial prize `challenge-initial-prize-${challengeId}`, and matching `-refund-` prefixes.

- **Charges/refunds reverse only real money** — `refundUserChallengeFunds` reverses collected fee charges (unpaid entries can't refund); on partial-charge failure, successful legs are refunded before throwing (no stranded Buzz).
- **Completion pool uses the REAL collected amount** — `prizePool` seeds to `basePrizePool` at create and increments only from charged entries; `User` completion derives the prize breakdown from `prizePool` + `prizeDistribution` (not from ACCEPTED row count). `System`/`Mod` stay count-based.
- **Residual refund on zero-winner completion** — a paid `User` challenge that completes with no winners refunds collected fees + initial prize. Partial-winner pro-rata is **(deferred)**.

### Safety / gating
- **Scan gate** — `getChallengeDetail(id, viewerId?)` returns `null` when `source === 'User' && scanStatus !== 'Scanned' && createdById !== viewer`. Activation excludes unscanned user challenges; a `Blocked` user challenge past its start is **auto-voided + refunded**.
- **Text moderation** — author text (title/theme/description/invitation) is scanned via XGuard on create + on any text edit (`scanUserChallenge` → `challengeModerationAdapter`). A `blocked` verdict hides the challenge (ingestion `Blocked`). An NSFW verdict escalates via `applyChallengeNsfwEscalation`: a **green** (`buzzType=green`, safe-site) user challenge is **voided** (`voidChallenge` — Cancelled + collection closed + initial prize refunded) and the creator is notified to recreate on civitai.red — green challenges must be SFW; a **yellow** challenge is instead raised to R (add the R bit + collection `forcedBrowsingLevel`) and stays live. Only the `nsfw` label is scanned for now (`suggestive`/`explicit` pending reliability), so nsfw's 0.75 threshold lets borderline text through.
- **Browsing level** — user challenges are not clamped to SFW; `InputContentRatingSelect` (defaults SFW, user-selectable) drives `allowedNsfwLevel` (1–63). NSFW isolation (real-cover `browsingLevel` exclusion + client `<Gated>` soft-gate) is handled in the blocker-fix work.
- **Orphan guard** — cover `createImage` runs after eligibility assertion, so an ineligible caller leaves no orphan Image.
- **Null-safe deleted creator** — `createdById` is nullable (`ON DELETE SET NULL`); `buildChallengeDetail` falls back to system user (`?? -1`).

### User challenge management
Creators can **view / edit / delete their own `User` challenges only while `Scheduled` with 0 entries**. End/void/pick-winners stay moderator-only.
- `deleteUserChallenge({ id, userId })` — `protectedProcedure`, both flags; guards owner + `source=User` + `Scheduled` + 0 entries, then `deleteChallenge` (refunds escrowed prize, cascades). Delete re-reads status so it **fails safe** if it races activation (blocks on `Active`); full idempotency under concurrent delete is an open verification item **(deferred)**.
- `getUserChallengeForEdit({ id, userId })` — owner-gated edit payload.
- `getInfiniteChallenges`/`getChallengeDetail` expose top-level **`createdById`** (the field all owner checks use).
- Client: `useDeleteUserChallenge()`, `ChallengeContextMenu` (owner Edit/Delete, self-gating), owner menu on `ChallengeCard` + detail; edit route `/challenges/[id]/edit` (`variant="user"`, standing-only); "My Challenges" mode at `/challenges?engagement=created` (creator exempt from scan gate, `visibleAt=now()`); nav link in the user dropdown.

---

## 7. Anti-gaming

- **User cooldown** 14 days; **resource cooldown** 90 days between features.
- **Entry cap** `maxEntriesPerUser` (2× the entry requirement); **scored cap** `maxScoredPerUser: 5` (only 5 entries/user get AI-scored).
- **Best-entry-per-user** in final judgment; **one winner per user** (top-N dedup).
- **Recency** — only images created during the window qualify.
- **INTEGRITY CHECK** — text in an image asking for a high score voids the entry.

---

## 8. Configuration & flags

**Config** (sysRedis `DAILY_CHALLENGE.CONFIG`, code-default fallback): `challengeType`, `userCooldown`, `resourceCooldown`, `prizes[]`, `entryPrizeRequirement`, `entryPrize`, `reviewAmount {min,max}`, `maxScoredPerUser`, `finalReviewAmount`. LLM prompt text is per-type in `ChallengeType`.

**Flipt flags**

| Flipt key | Feature flag | Gates |
|---|---|---|
| `challenge-platform-enabled` | `challengePlatform` | whole platform |
| `user-challenges` | `userChallenges` | user create/manage (**tester rollout**) |

Flipt is **GitOps-only** (writes via the GitOps repo, not the API).

---

## 9. Operations: judging-setup migrations & release runbook

DB-content changes for judging are **applied manually per environment** (retool/psql) — the repo does
not auto-run them (`prisma migrate deploy` is never used here). The rubric SQL is maintained in
gitignored `scripts/migrations/*.local.sql`:

| File | Effect | Depends on |
|---|---|---|
| `prisma/migrations/20260709201808_challenge_category_table` (committed) | Creates `ChallengeCategory` + inserts 26 rows (structure + terse `criteria`) | Apply first — the seed below UPDATEs these rows |
| `challenge-category-rubric-seed.local.sql` | UPDATEs the rich `rubric` / `rubricNsfw` for all 26 categories (idempotent) | **Required** — an unseeded table degrades judging to terse criteria |
| `dynamic-judging-categories-judge-prompts.local.sql` | Replaces baked blocks → `{{SCORING_RUBRICS}}` sentinel for CivBot/CivChan/GigaBot | **the `buildFallbackMessages` default-rubric fallback must be deployed first** |
| `test-judge-sentinel.local.sql` | Optional hidden `CivBot Sentinel Test` judge for pre-flight validation | none |

**⚠️ Ordering (per environment):**

1. **Deploy** the application code carrying `injectRubrics` / `buildFallbackMessages` default-rubric fallback to the environment.
2. **Only then** apply `dynamic-judging-categories-judge-prompts.local.sql`. Applying it before the deploy sends a literal `{{SCORING_RUBRICS}}` (with zero scoring criteria) to the LLM — a real regression, not a graceful no-op.
3. Apply the structural category migration, then `challenge-category-rubric-seed.local.sql` — deploy-independent, but **required** for full-quality judging (an unseeded/partially-seeded table falls back to terse criteria).
4. Enabling `user-challenges` before the sentinel migration is safe but means testers' custom categories are silently ignored (judge falls back to baked blocks). Prefer: migrate judges, then open the flag.

**Verification** (after applying the judge-prompt file): expect `has_sentinel = true` and `blocks_removed = true` for CivBot/CivChan/GigaBot:

```sql
SELECT name,
  position('{{SCORING_RUBRICS}}' in "reviewPrompt") > 0 AS has_sentinel,
  "reviewPrompt" NOT LIKE '%THEME SCORING (0-10):%'    AS blocks_removed
FROM "ChallengeJudge" WHERE name IN ('CivBot','CivChan','GigaBot');
```

**Release-to-testers sequence**: merge `feat/public-challenges` → deploy lands in prod → apply the judge-prompt sentinel SQL (verify) → enable `user-challenges` with a segmented rollout to the tester segment.

---

## 10. Database tables

- **`Challenge`** — `startsAt`/`endsAt`/`visibleAt`; `title`/`description`/`theme`/`coverImageId`; `nsfwLevel`/`allowedNsfwLevel` (bitwise); `modelVersionIds Int[]` (OR-match); `collectionId`; `maxEntriesPerUser`; `prizes`/`entryPrize`/`entryPrizeRequirement`/`prizePool`; `judgingCategories Json?`; `createdById` (nullable), `judgeId`, `source`, `status`, `scanStatus`; `metadata Json` (`completionSummary`, `challengeType`).
- **`ChallengeType`** — LLM prompts (`promptSystemMessage`, `promptCollection`, `promptArticle`, `promptReview`, `promptWinner`).
- **`ChallengeJudge`** — persona prompts/bios, incl. `reviewPrompt` (carries the sentinel post-migration), `active`.
- **`ChallengeCategory`** — the judging-category library (§5).
- **`ChallengeWinner`** — `challengeId`/`userId`/`imageId`/`place`/`buzzAwarded`/`pointsAwarded`/`reason`; `@@unique([challengeId, place])`.
- **Entries** = `CollectionItem` rows in the challenge collection (`status`, `note` carries score JSON) — no dedicated entry table.
