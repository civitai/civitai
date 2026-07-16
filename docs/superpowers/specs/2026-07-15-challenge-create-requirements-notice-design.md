# Surface challenge-create requirements on `/challenges/create`

**Date:** 2026-07-15
**Branch base:** `feat/public-challenges`
**Status:** Design approved, pending spec review

## Problem

Creating a public (User-source) challenge is gated behind a set of eligibility
checks — most notably a minimum creator score of 5,000 — but **none of these
requirements are surfaced to the user before they submit**. The "Create a
Challenge" CTA (challenges index page and user menu) is shown to everyone the
feature flags allow, and the user only discovers the requirement reactively:
they fill out the entire create form, submit, and the `upsertUserChallenge`
mutation throws, surfacing a backend error string as a toast
(`ChallengeUpsertForm.tsx:352`). "Find out you're not eligible by failing" is
poor UX.

## Goal

On `/challenges/create`, proactively show an ineligible user *why* they can't
create a challenge — mirroring the existing "Join the Creator Program"
requirements card in the buzz dashboard — instead of letting them fill out a
form they can't submit.

## Current state (verified)

### Enforcement gates (create-only)
All live in `src/server/services/challenge-eligibility.service.ts`. Create
requires **all** of the following; each `assert*` throws on the **first**
failure (no structured "all requirements + status" evaluator exists):

| Gate | Rule | Source |
|---|---|---|
| Creator score | `User.meta.scores.total` ≥ `CHALLENGE_MIN_CREATOR_SCORE` (5,000) | `assertUserInGoodStanding:62-68` |
| Account standing | not banned/deleted, not muted, 0 active strikes | `assertUserAccountInGoodStanding:49-59` |
| Daily create limit | < `CHALLENGE_CREATE_DAILY_LIMIT` User-source challenges in last 24h | `assertUnderDailyCreateLimit:74-90` |
| Active challenge limit | < `getChallengeActiveLimit(tier)` Scheduled/Active challenges | `assertUnderActiveChallengeLimit:93-113` |

`assertCanCreateUserChallenge(userId)` (`:116-120`) chains all three, invoked
from `challenge.service.ts:1411` only when creating (no `id`). Constants live in
`src/shared/constants/challenge.constants.ts`.

### Score is not available client-side
`CurrentUser` (`CivitaiSessionProvider`) carries no score field, and there is no
challenge eligibility tRPC query. So the client currently cannot know the user's
score without a new backend call.

### Reuse reference — Creator Program card
The buzz dashboard already solves the analogous problem:
- `useCreatorProgramRequirements()` (`CreatorProgram.util.ts:10`) →
  `trpc.creatorProgram.getCreatorRequirements` returns `{ score: { min, current } }`.
- Server handler `getCreatorRequirements` (`creator-program.service.ts:207-242`)
  reads `User.meta.scores` but computes `current = GREATEST(sum of components, total)`
  with threshold `MIN_CREATOR_SCORE = 40000`.
- `CreatorProgramRequirement({ title, content, isMet })`
  (`CreatorProgramV2.tsx:307`) renders generic green-check / red-X rows.
- `openCreatorScoreModal()` (`CreatorProgramV2.modals.tsx:236`, exported) opens a
  "What is your Creator Score?" explainer.

## Design

### 1. Backend — read-only eligibility evaluator + query

Add a **non-throwing** evaluator to `challenge-eligibility.service.ts`:

```ts
export type ChallengeCreateRequirement =
  | { key: 'score'; met: boolean; current: number; min: number }
  | { key: 'standing'; met: boolean; muted: boolean; activeStrikes: number; banned: boolean }
  | { key: 'dailyLimit'; met: boolean; recentCount: number; limit: number }
  | { key: 'activeLimit'; met: boolean; activeCount: number; limit: number };

export type ChallengeCreateEligibility = {
  canCreate: boolean;
  requirements: ChallengeCreateRequirement[];
};

export async function getUserChallengeCreateEligibility(
  userId: number
): Promise<ChallengeCreateEligibility>;
```

It runs the same four checks as the `assert*` path — reusing
`getUserChallengeStanding` (same `meta.scores.total` source), the same
`dbRead.challenge.count` daily/active queries, `getHighestTierSubscription`, and
the **same shared constants** — but returns statuses instead of throwing.
`canCreate` is `requirements.every(r => r.met)`.

**Single source of truth:** the `assert*` functions remain the enforcement
boundary and continue to gate the mutation (belt-and-suspenders). Because both
paths read the same standing/count helpers and the same constants, the displayed
requirements cannot drift from what is enforced. Where practical, factor the
per-check predicate (e.g. score-met, under-daily-limit) into a small shared
helper consumed by both the evaluator and its matching `assert*`, so the two
stay in lockstep without duplicating threshold logic.

Expose via the router (`challenge.router.ts`):

```ts
getCreateEligibility: protectedProcedure
  .use(isFlagProtected('challengePlatform'))
  .use(isFlagProtected('userChallenges'))
  .query(({ ctx }) => getUserChallengeCreateEligibility(ctx.user.id)),
```

No zod input (uses `ctx.user.id`), matching the other user-challenge routes'
flag guards.

### 2. Score source — accepted divergence

The challenge card shows `meta.scores.total` **alone** (threshold 5,000) because
that is exactly what the create gate enforces — display must equal enforcement.
The Creator Program card shows `GREATEST(components_sum, total)` (threshold
40,000). The two cards can therefore show slightly different score numbers for
the same user. Truthfulness to the actual gate wins; this is an accepted
tradeoff. Aligning the challenge gate to `GREATEST(...)` is a policy change and
is out of scope for this work.

### 3. Frontend — block on ineligibility

New component `src/components/Challenge/ChallengeCreateRequirements.tsx`:
- Presentational card given a `ChallengeCreateEligibility`.
- Header, e.g. "Requirements to create a challenge".
- Renders a **challenge-specific** requirement row component (a small local
  component in the same file — *not* a reuse of `CreatorProgramRequirement`, per
  product decision) with the green-check / red-X treatment.
- Rows: score, standing, and active-limit render always (each met/unmet). The
  **daily-create-limit** row is an anti-spam throttle, not a standing entitlement
  — showing "5/day allowed" beside the "1 active" cap reads as a contradiction,
  so it renders only when it is the actual blocker (unmet). The evaluator still
  computes it and `canCreate` still accounts for it.
  - **Creator Score** — headline row. Title: `Have a creator score of at least 5,000`.
    Content: `Your current Creator Score is {abbreviateNumber(current)}.` with
    "Creator Score" rendered as a link that calls `openCreatorScoreModal()`
    (imported from `CreatorProgramV2.modals`) — the explainer link.
  - **Account in good standing** — content reflects the failing sub-reason
    (muted / active strikes / banned) or "good standing" when met.
  - **Daily create limit** — content: `You've created {recentCount} of {limit}
    challenges allowed in the last 24 hours.`
  - **Active challenge limit** — content: `You have {activeCount} of {limit}
    active challenges for your membership tier.`

Wire into `src/pages/challenges/create.tsx`:

```tsx
const currentUser = useCurrentUser();
const { data: eligibility, isLoading } =
  trpc.challenge.getCreateEligibility.useQuery(undefined, { enabled: !!currentUser });

if (isLoading) return <PageLoader />;
if (eligibility && !eligibility.canCreate)
  return <ChallengeCreateRequirements eligibility={eligibility} />;
return <ChallengeUpsertForm variant="user" />;
```

Existing SSR flag guards (`create.tsx:31`) are unchanged.

**Query-error fallback:** if `getCreateEligibility` errors (not merely
ineligible), render the form. The backend `assert*` gate still enforces on
submit, degrading gracefully to today's error-toast behavior rather than hard-
blocking a possibly-eligible user on a transient read failure.

### 4. Scope

- Index-page "Create Challenge" CTA and the user-menu "Create a Challenge" item
  stay **ungated** on eligibility. Clicking either routes to `/challenges/create`,
  which now shows the blocking requirements card for ineligible users. No change
  to those entry points.
- No change to the enforcement path or the mutation's error handling; the card
  is additive.

## Testing

Extend `src/server/services/__tests__/challenge-eligibility.service.test.ts`:
- `getUserChallengeCreateEligibility` returns `canCreate: true` with every row
  `met` for an eligible user.
- Score below threshold → `canCreate: false`, only the `score` row unmet, with
  correct `current`/`min`.
- Muted / active strikes / banned → `standing` row unmet.
- Daily limit reached → `dailyLimit` row unmet with `recentCount`/`limit`.
- Active limit reached → `activeLimit` row unmet with `activeCount`/`limit`.
- **Parity test:** for a representative matrix of standings, the evaluator's
  `canCreate` equals "`assertCanCreateUserChallenge` does not throw", guarding
  against display/enforcement drift.

## Files touched

| File | Change |
|---|---|
| `src/server/services/challenge-eligibility.service.ts` | add `getUserChallengeCreateEligibility` + types; optionally factor shared per-check predicates |
| `src/server/routers/challenge.router.ts` | add `getCreateEligibility` query |
| `src/components/Challenge/ChallengeCreateRequirements.tsx` | new card + challenge-specific requirement row |
| `src/pages/challenges/create.tsx` | fetch eligibility; block with card vs. render form |
| `src/server/services/__tests__/challenge-eligibility.service.test.ts` | evaluator + parity tests |

## Out of scope
- Aligning the challenge score source to Creator Program's `GREATEST(...)`.
- Gating the index/user-menu CTAs on eligibility.
- Any change to the enforcement gates themselves.
