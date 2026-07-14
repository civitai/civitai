# Public Challenges — Release Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the release blockers found in the pre-release audit of `feat/public-challenges`: NSFW cross-domain / real-image leaks (feed, detail, winners, frontend), the moderator "end early" currency+spoof bug, and the buzz refund double-spend race.

**Architecture:** Adopt the established site-wide content-filtering pattern (models/comics) for challenges: filter by the viewer's **effective (green-capped) browsingLevel** against the **cover image's real `nsfwLevel`**, and **exclude the whole challenge** from any list when its cover fails (models-style, `model.service.ts:753`), rather than showing a coverless card. Hard-block the detail page on green for an unsafe cover. Wire the two winner endpoints (which today have no domain isolation at all) with the same `isGreen` + domain-currency + cover-nsfw gates the feed already has. For money-safety, reuse the cron path's hardened `buildWinnerPayoutTransactions` + `creatorId`-only winner mapping on the mod path, and add an atomic status-claim before refunds so a concurrent void/delete cannot double-refund.

**Tech Stack:** Next.js 14 / tRPC / Prisma (raw `Prisma.sql`), Vitest, Mantine v7 + Tailwind frontend, `ImageGuard2` / `EdgeMedia2` client gating.

**Branch:** `fix/public-challenges-blockers`, based on `feat/public-challenges` (the feature integration branch — NOT `main`, which has none of the challenge code). One PR.

## Global Constraints

- **`.com` (green) = SFW-only; `.red` = NSFW-allowed.** An NSFW challenge, cover, or winner image must never reach a green viewer. Treat **unknown/unrated `nsfwLevel = 0` as unsafe** on green.
- **`allowedNsfwLevel` (challenge-declared ceiling) ≠ image `nsfwLevel` (scanner-assigned real level).** All new gates key on the **cover image's real `nsfwLevel`**, never on `allowedNsfwLevel`.
- **Green cap is server-authoritative.** `browsingLevel` arriving from the client is bitwise-AND'd against `greenCap` on green; a hand-crafted request must not raise the ceiling. `greenCap = ctx.user ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag` (logged-in → PG+PG13; anon → PG only). Pattern source: `comics.router.ts:1334-1340`.
- **Money paths stay idempotent.** No change may create a path that pays or refunds twice. Winner mapping keys on numeric `creatorId` only. Payout currency = the challenge's stored `buzzType`, never hardcoded.
- **Follow project rules:** read the full function before editing; `Input*` form wrappers on the frontend; tests are **Vitest** (`pnpm vitest run <path>`), never under `src/pages`; do not run prettier manually.

## Non-code pre-deploy checklist (surface to the user; NOT code tasks)

- [ ] Create Flipt flags `user-challenges` and `challenge-platform-enabled` **DISABLED** in each env via **GitOps** (Flipt v2 is GitOps-only; API writes 501). The kill-switches fail OPEN (`feature-flags.service.ts:327`) — absent flag ⇒ feature live-to-all on deploy.
- [ ] Apply all 4 challenge migrations manually (repo-root `prisma/migrations/`), especially `20260713162642_challenge_buzztype` — the whole challenge read path selects `buzzType`; unapplied ⇒ every challenge detail read throws site-wide.
- [ ] Add the `{{SCORING_RUBRICS}}` sentinel to CivBot/CivChan `reviewPrompt` per-env, or dynamic judging ships silently inert.

---

## Task 1: Fetch the cover image's real `nsfwLevel` (data foundation)

Every NSFW gate below needs the cover image's real level, which is currently never selected.

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts` — the challenge SELECT (~`:146-151`), the row type (~`:69-74`), and the `ChallengeListItem`/`ChallengeDetail` mapped types (~`:113-128`).

**Interfaces:**
- Produces: challenge row + `ChallengeListItem` + `ChallengeDetail` gain `coverImageNsfwLevel: number | null` (real scanner level of the cover `Image`, `null` when `coverImageId` is null).

- [ ] **Step 1 — Add the column to the raw SELECT.** In the `getChallengesByIds`/detail SELECT block, after the existing cover subselects (`:150`), add:
  ```sql
  (SELECT "nsfwLevel" FROM "Image" WHERE id = c."coverImageId") as "coverImageNsfwLevel",
  ```
  Keep `c."nsfwLevel"` (declared-derived) — it still drives display badges; do not remove it.
- [ ] **Step 2 — Thread the field through the row type and the two public mapped types** (`coverImageNsfwLevel: number | null`). Populate it in whatever maps rows → `ChallengeListItem`/`ChallengeDetail` (mirror how `coverUrl` is carried).
- [ ] **Step 3 — Typecheck** (editor diagnostics; do not run `pnpm typecheck` unprompted per project rule). Expected: no new errors.
- [ ] **Step 4 — Commit:** `fix(challenges): select real cover image nsfwLevel for content gating`

---

## Task 2: Green-cap helper + feed exclusion on real cover nsfwLevel

Fixes: feed shows NSFW-covered challenges; client can omit `browsingLevel` to disable the filter; declared-level trust.

**Files:**
- Create: `src/server/games/daily-challenge/challenge-visibility.ts` — add `getEffectiveBrowsingLevel` (co-locate with the existing cover/POI visibility helpers).
- Modify: `src/server/services/challenge.service.ts` — `getInfiniteChallenges` (browsingLevel handling ~`:465-468`; it already receives `isGreen` and `currentUserId`).
- Test: `src/server/games/daily-challenge/challenge-visibility.test.ts` (exists — extend it).

**Interfaces:**
- Produces: `getEffectiveBrowsingLevel({ isGreen, isLoggedIn, requested }: { isGreen: boolean; isLoggedIn: boolean; requested?: number | null }): number` — on green returns `(requested ?? greenCap) & greenCap` (never null/unclamped); off green returns `requested ?? 0` unchanged.

- [ ] **Step 1 — Failing test** in `challenge-visibility.test.ts`:
  ```ts
  import { getEffectiveBrowsingLevel } from './challenge-visibility';
  import { sfwBrowsingLevelsFlag, publicBrowsingLevelsFlag, nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
  import { Flags } from '~/shared/utils/flags';

  it('clamps green logged-in to SFW and strips NSFW bits from a crafted request', () => {
    const lvl = getEffectiveBrowsingLevel({ isGreen: true, isLoggedIn: true, requested: nsfwBrowsingLevelsFlag });
    expect(Flags.intersects(lvl, nsfwBrowsingLevelsFlag)).toBe(false);
    expect(lvl).toBe(nsfwBrowsingLevelsFlag & sfwBrowsingLevelsFlag); // === 0
  });
  it('defaults green to the cap when no level requested (anon = PG only)', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: true, isLoggedIn: false })).toBe(publicBrowsingLevelsFlag);
  });
  it('passes the request through unchanged off green', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: false, isLoggedIn: true, requested: 28 })).toBe(28);
  });
  ```
- [ ] **Step 2 — Run:** `pnpm vitest run src/server/games/daily-challenge/challenge-visibility.test.ts` → FAIL (not defined).
- [ ] **Step 3 — Implement** `getEffectiveBrowsingLevel` in `challenge-visibility.ts`:
  ```ts
  import { sfwBrowsingLevelsFlag, publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

  export function getEffectiveBrowsingLevel({ isGreen, isLoggedIn, requested }: {
    isGreen: boolean; isLoggedIn: boolean; requested?: number | null;
  }): number {
    if (!isGreen) return requested && requested > 0 ? requested : 0;
    const greenCap = isLoggedIn ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
    return requested && requested > 0 ? requested & greenCap : greenCap;
  }
  ```
- [ ] **Step 4 — Run the test** → PASS.
- [ ] **Step 5 — Apply in `getInfiniteChallenges`.** Compute once near the top of the WHERE build:
  ```ts
  const effectiveBrowsingLevel = getEffectiveBrowsingLevel({
    isGreen: isGreen ?? false, isLoggedIn: currentUserId != null, requested: browsingLevel,
  });
  ```
  Replace the current `if (browsingLevel) { conditions.push((c."allowedNsfwLevel" & browsingLevel) > 0) }` block with a **cover-image** gate that excludes the challenge when its real cover level fails, while keeping creator-exempt + safe handling of a null cover / System challenges (which have no user cover to police). Off green (`effectiveBrowsingLevel === 0`) applies no restriction:
  ```ts
  if (effectiveBrowsingLevel > 0) {
    conditions.push(Prisma.sql`(
      c."createdById" = ${currentUserId ?? -1}
      OR EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i.id = c."coverImageId" AND (i."nsfwLevel" & ${effectiveBrowsingLevel}) <> 0
      )
    )`);
  }
  ```
  Note: this AND-combines with the existing scan-completion EXISTS and the domain-currency filter already present (`:425`). A challenge with no `coverImageId` is excluded on green by this EXISTS — confirm in Step 6 whether user challenges can lack a cover; if they can, add `c."coverImageId" IS NULL OR …` and fall back to `c."nsfwLevel"`.
- [ ] **Step 6 — Verify cover requiredness.** Grep the upsert schema/service: does a User challenge require `coverImageId`? If required (expected), no null-branch needed. Record the finding in the commit body.
- [ ] **Step 7 — Extend the feed test** (`challenge-visibility.test.ts` or the service test) with a case: green viewer + challenge whose cover `nsfwLevel` is NSFW ⇒ excluded; same cover SFW ⇒ included; creator sees own regardless.
- [ ] **Step 8 — Commit:** `fix(challenges): exclude NSFW-covered challenges from green feed via real image level`

---

## Task 3: Hard-block the detail page on green for an unsafe cover

Fixes blocker #2 (Mod/System NSFW challenge reachable by direct URL on .com) and #4 (green challenge, NSFW cover).

**Files:**
- Modify: `src/server/services/challenge.service.ts` — `getChallengeDetail` (~`:868-942`; cover lookup at `:899-901` currently selects only `{ poi, ingestion }`).
- Test: `src/server/services/__tests__/challenge-edit.service.test.ts` sibling, or add `challenge-detail-visibility.service.test.ts`.

**Interfaces:**
- Consumes: `getEffectiveBrowsingLevel` (Task 2), `hasSafeBrowsingLevel`/`hasPublicBrowsingLevel` (`browsingLevel.constants.ts:233,237`).

- [ ] **Step 1 — Add `nsfwLevel` to the cover lookup** at `:899`:
  ```ts
  select: { poi: true, ingestion: true, nsfwLevel: true },
  ```
- [ ] **Step 2 — After the existing cover-scan/POI gate, add the green NSFW gate** (creator/mod-preview already bypass earlier gates; keep parity — do NOT bypass the NSFW gate for a non-owner green viewer). Applies to **all sources** (this is what closes the Mod/System case):
  ```ts
  // Green (.com) hard-block: never serve a challenge whose cover image is not SFW, regardless of
  // source. Creator viewing their own is exempt (they can already see pending/blocked above).
  if (isGreen && challenge.createdById !== viewerId && challenge.coverImageId) {
    const passes = viewerId != null ? hasSafeBrowsingLevel : hasPublicBrowsingLevel;
    if (cover?.nsfwLevel == null || cover.nsfwLevel === 0 || !passes(cover.nsfwLevel)) return null;
  }
  ```
  (`cover` is the row already fetched at `:899`. Reuse it — do not add a second query.)
- [ ] **Step 3 — Test:** green non-owner + NSFW cover ⇒ `getChallengeDetail` returns `null`; `.red` viewer ⇒ returns detail; creator on green ⇒ returns detail. Mock `getChallengeById` + `dbRead.image.findUnique`.
- [ ] **Step 4 — Run** the new test → PASS.
- [ ] **Step 5 — Commit:** `fix(challenges): hard-block NSFW-cover challenge detail on green (all sources)`

---

## Task 4: Wire domain + NSFW isolation into the winner endpoints

Fixes blocker #1 — `getCompletedChallengesWithWinners` and `getWinners` today pass no `isGreen` and have zero domain/NSFW filter.

**Files:**
- Modify: `src/server/routers/challenge.router.ts` — `getCompletedWithWinners` (~`:114`), `getWinners` (~`:108`) to pass `ctx.features.isGreen` + `ctx.user?.id`.
- Modify: `src/server/services/challenge.service.ts` — `getCompletedChallengesWithWinners` (~`:3069`), and the `getWinners`/`getChallengeWinners` service fn.
- Modify: `src/server/schema/challenge.schema.ts` — extend the winners input types with optional `isGreen`/`currentUserId` **only if** you pass them via the fn arg object (preferred: extend the fn signature like `getInfiniteChallenges` does with `& { currentUserId?: number; isGreen?: boolean }`, not the zod input).

**Interfaces:**
- Consumes: `deriveDomainCurrency`, `isChallengeHiddenByDomainCurrency` (`challenge-currency.ts`), `getEffectiveBrowsingLevel` (Task 2), the `coverImageNsfwLevel` column (Task 1), winner-row `imageNsfwLevel` (`challenge-helpers.ts:607`, already present).

- [ ] **Step 1 — Router:** change both winner procedures to
  ```ts
  .query(({ input, ctx }) => getCompletedChallengesWithWinners({ ...input, isGreen: ctx.features.isGreen, currentUserId: ctx.user?.id }))
  ```
  (and the analogous change for `getWinners` → `getChallengeWinners`).
- [ ] **Step 2 — Service signature:** widen to `GetCompletedChallengesWithWinnersInput & { isGreen?: boolean; currentUserId?: number }`.
- [ ] **Step 3 — Add the domain-currency SQL filter** (mirror the feed `:425`), so a User challenge only appears on its own domain:
  ```ts
  const domainCurrency = deriveDomainCurrency(isGreen ?? false);
  conditions.push(
    currentUserId
      ? Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency} OR c."createdById" = ${currentUserId})`
      : Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency})`
  );
  ```
- [ ] **Step 4 — Replace the optional `browsingLevel` filter (`:3086`) with the effective-level cover-nsfw exclusion** (same shape as Task 2 Step 5), so an NSFW-covered completed challenge never lists on green.
- [ ] **Step 5 — Defense-in-depth on winner thumbnails:** in the winner-row mapping, null `imageUrl` when `isGreen && !passes(imageNsfwLevel)` (`passes = currentUserId ? hasSafeBrowsingLevel : hasPublicBrowsingLevel`). Green challenges' entries are already SFW by the entry-eligibility gate, but this guarantees no mislabeled thumbnail slips through. Frontend `WinnerPodiumCard` already keys `ImageGuard2` on `imageNsfwLevel` — this is server belt-and-suspenders.
- [ ] **Step 6 — Test** (`challenge-winner-mapping.test.ts` sibling or new): green viewer + yellow User challenge with winners ⇒ excluded; green viewer + NSFW-cover challenge ⇒ excluded; `.red` viewer ⇒ included.
- [ ] **Step 7 — Commit:** `fix(challenges): apply domain + NSFW isolation to winner endpoints`

---

## Task 5: Frontend — key `ImageGuard2` on the real cover level

Fixes the client-side mirror: `ChallengeCard.tsx:108` and the detail cover feed the *declared* level to the guard.

**Files:**
- Modify: `src/components/Cards/ChallengeCard.tsx` (~`:101-109`).
- Modify: `src/pages/challenges/[id]/[[...slug]].tsx` — the `coverImage` object handed to `ImageGuard2` (~`:555-574`).
- Verify: `src/components/Challenge/challenge.utils.ts:25,74` already sends `browsingLevel` to the query (keep).

**Interfaces:**
- Consumes: `coverImageNsfwLevel` from `ChallengeListItem`/`ChallengeDetail` (Task 1).

- [ ] **Step 1 — ChallengeCard:** set the guard image's `nsfwLevel` to the **cover image's real level**, falling back to the declared level only when the real level is missing:
  ```ts
  nsfwLevel: coverImageNsfwLevel ?? nsfwLevel, // real scanner level drives the blur, not the declared ceiling
  ```
  Remove the stale `// Use challenge content level instead of image's own level` comment.
- [ ] **Step 2 — Detail:** ensure `challenge.coverImage.nsfwLevel` passed to `ImageGuard2` is `coverImageNsfwLevel` (real), not the declared level. Adjust the object construction where `coverImage` is assembled.
- [ ] **Step 3 — Component smoke check** via the `component-preview` skill (dark + light): SFW cover renders; an NSFW-level cover shows the `ImageGuard2` blur/toggle. (Server exclusion means green users won't receive NSFW cards, but the guard must still be correct for `.red` and borderline levels.)
- [ ] **Step 4 — Commit:** `fix(challenges): blur challenge cover on real image nsfwLevel, not declared level`

---

## Task 6: Fix the moderator "end early" payout (currency + spoof)

Fixes blocker #5 — `endChallengeAndPickWinners` (`challenge.service.ts:2138,2181`) hardcodes `toAccountType:'yellow'` and maps winners by spoofable username. The cron path is already hardened; reuse it.

**Files:**
- Modify: `src/server/services/challenge.service.ts` — `endChallengeAndPickWinners` winner-map (~`:2138-2142`) and payout (~`:2172-2185`).
- Test: `src/server/services/__tests__/challenge-winner-mapping.test.ts` (extend to cover the mod path).

**Interfaces:**
- Consumes: `buildWinnerPayoutTransactions({ challengeId, title, buzzType, winners })` (`challenge-funding.ts`), the challenge's stored `buzzType`.

- [ ] **Step 1 — Failing test:** two entrants where entrant B's `username` equals entrant A's, LLM returns `creatorId` = A ⇒ the winner must map to A's `userId`, and for a `green` challenge the payout `toAccountType` must be `'green'` (assert against a captured `createBuzzTransactionMany`/`buildWinnerPayoutTransactions` arg). → FAIL today.
- [ ] **Step 2 — Winner map → `creatorId` only** (copy the cron rationale comment from `daily-challenge-processing.ts:1405`):
  ```ts
  const entry = judgedEntries.find((e) => e.userId === winner.creatorId);
  ```
  Drop the `e.username.toLowerCase() === winner.creator.toLowerCase() ||` clause.
- [ ] **Step 3 — Payout → stored buzzType via the shared builder.** Replace the inline `createBuzzTransactionMany([... toAccountType:'yellow' ...])` with:
  ```ts
  await withRetries(() =>
    createBuzzTransactionMany(
      buildWinnerPayoutTransactions({
        challengeId, title: challenge.title, buzzType: challenge.buzzType, winners: winningEntries,
      })
    )
  );
  ```
  (Confirm `challenge.buzzType` is in scope in this fn; if not, select it. `winningEntries` must expose `{ userId, position, prize }` as the builder expects — it does per the cron call.)
- [ ] **Step 4 — Check the participation-prize block just below** (`:2185+`) for the same hardcoded `'yellow'`; if the entry-prize path can run for a green challenge, route it through the stored `buzzType` too. (Entry prizes are null for entry-fee User challenges, but a mod-run challenge could set one.)
- [ ] **Step 5 — Run the test** → PASS.
- [ ] **Step 6 — Commit:** `fix(challenges): mod end-early pays stored buzzType + maps winners by creatorId`

---

## Task 7: Make void/delete refunds concurrency-safe

Fixes blocker #4 (double-refund → minted Buzz) and the delete-vs-activation replica-read race.

**Files:**
- Modify: `src/server/services/challenge.service.ts` — `voidChallenge` (~`:2380`), `deleteChallenge` (~`:1688`), `deleteUserChallenge` (~`:1738`).
- Test: `src/server/services/__tests__/challenge-delete-user.service.test.ts` (extend).

**Design decision (must confirm first):** The in-repo refund relies on the external buzz service's prefix-refund being idempotent — unverifiable here. Regardless of that answer, add an **app-side atomic status claim** so only one caller ever reaches the refund. This is the models-safe equivalent of the cron path's `claimChallengeForCompletion` (atomic `UPDATE … WHERE status = …`).

- [ ] **Step 0 — Verify (blocking):** confirm whether `buzzService.refundMultiTransaction` / `refundMultiAccountTransaction` dedups an already-applied prefix refund under concurrency (read the buzz service or ask the team). Record the answer in the PR. The claim below is required either way; this only tells us whether it was already latently safe.
- [ ] **Step 1 — Failing test:** two concurrent `deleteUserChallenge` calls on one Scheduled challenge ⇒ `refundUserChallengeFunds` is invoked **exactly once** (spy). → FAIL today (both invoke it).
- [ ] **Step 2 — `deleteChallenge`: read status on `dbWrite`, not the replica**, and gate the refund + delete on an **atomic claim**. Replace the replica `dbRead.challenge.findUnique` with a conditional claim that transitions the row out of `Scheduled` (or use a `deletedAt`/`refundedAt` marker if the team prefers a marker to a status). Minimal status-based approach:
  ```ts
  // Atomically claim the Scheduled row; only the winner of this claim refunds + deletes.
  const claimed = await dbWrite.challenge.updateMany({
    where: { id, status: ChallengeStatus.Scheduled, source: ChallengeSource.User },
    data: { status: ChallengeStatus.Cancelled },
  });
  if (claimed.count !== 1) {
    // lost the race (already cancelled/deleted/activated) — do not refund again
    return { success: true };
  }
  await refundUserChallengeFunds(id);
  // …then delete challenge + collection as today.
  ```
  Keep the existing "block Active" semantics: the `WHERE status = Scheduled` guard already refuses an Active row (claim.count = 0) — surface a `PRECONDITION_FAILED` for the operator-facing `deleteChallenge` path if the row exists but wasn't Scheduled, matching current messaging.
- [ ] **Step 3 — `voidChallenge`: same atomic claim** before `refundUserChallengeFunds`. Claim `WHERE status IN (Active, Scheduled)` → Cancelled; if `count !== 1`, return early (already voided). Preserve the "close collection" step; run it before the claim (idempotent) or after — but the refund runs only on a won claim. Update the existing "Refund BEFORE flipping" comment to reflect the claim-first ordering.
- [ ] **Step 4 — Confirm refund stays retry-safe:** if the buzz call throws after a won claim, the row is already Cancelled and won't be re-claimed. Because `refundUserChallengeFunds` uses deterministic `externalTransactionId`s, a manual re-run is safe; note this in the comment. (If Step 0 finds the buzz service is NOT idempotent, add a `refundedAt` marker column instead so a post-claim crash can be retried without a second net refund — flag this to the user as a possible migration.)
- [ ] **Step 5 — Run the concurrency test** → PASS (single refund).
- [ ] **Step 6 — Commit:** `fix(challenges): atomic status-claim before void/delete refund to stop double-spend`

---

## Self-Review

- **Spec coverage:** #1 winners leak → Task 4; #2 detail Mod/System → Task 3; #3 feed bypass/declared-level → Task 2; #4 green NSFW cover → Tasks 2+3+5; buzz double-refund → Task 7; mod payout currency+spoof → Task 6; frontend filtering (user's ask) → Task 5; delete-vs-activation race → Task 7 Step 2. Ops (flags/migrations/sentinel) → pre-deploy checklist. ✅
- **Data dependency:** Tasks 2/3/4/5 all consume `coverImageNsfwLevel` from Task 1 — Task 1 must land first.
- **Type consistency:** `getEffectiveBrowsingLevel` signature identical in Tasks 2/3/4. `buildWinnerPayoutTransactions({ challengeId, title, buzzType, winners })` matches the cron call in Task 6.
- **Open item for the user:** Task 7 Step 0 (buzz-service idempotency) may promote a `refundedAt` migration; Task 2 Step 6 may add a null-cover branch. Both flagged inline.
