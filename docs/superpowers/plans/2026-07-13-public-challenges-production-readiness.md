# Public Challenges Production Readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user-created (public) challenges production-ready by fixing job scalability, house-cut economics/observability, money leaks, moderation gating, and abuse controls.

**Architecture:** Incremental hardening of the existing `Challenge` system on branch `feat/public-challenges`. No new tables. Reuse the existing (currently-dead) `operationSpent` column for spend observability. All work stays behind the `challengePlatform` + `userChallenges` feature flags. Jobs move from single-challenge assumptions to bounded, concurrent, batch processing.

**Tech Stack:** Next.js 14 / TypeScript, Prisma (Postgres), tRPC, Vitest, OpenRouter (gpt-5-nano review / gpt-4o-mini winner-pick), Redis, Axiom logging, `limitConcurrency` from `~/server/utils/concurrency-helpers`.

**Spec:** `docs/superpowers/specs/2026-07-13-public-challenges-production-readiness-design.md`

## Global Constraints

- **Never use the Haiku model for implementation** (per session directive). Subagents run on Sonnet or Opus only.
- **Migrations are applied manually.** Never run/suggest `prisma migrate deploy`. If a migration is added, write SQL under `prisma/migrations/`, commit, and surface it for manual apply. Prefer NO new columns/indexes — verify existing `@@index([status, endsAt])` / `([status, startsAt])` cover new query shapes before adding any.
- **Never edit `prisma/schema.prisma` directly** — edit `prisma/schema.full.prisma` then `pnpm run db:generate`. (Not expected to be needed here.)
- **No unit tests under `src/pages`** — job/handler tests go in `src/server/**/__tests__/` (Vitest). Run tests with `pnpm vitest run <path>`.
- **Do not run prettier manually** — handled automatically.
- **Feature flags:** `challengePlatform` (`challenge-platform-enabled`), `userChallenges` (`user-challenges`). No new flag.
- **Buzz economics (verified 2026-07-13):** buzz = $0.001 (`buzzDollarRatio = 1000`); house cut `CHALLENGE_ENTRY_HOUSE_CUT = 25` Buzz/entry; review ≈ 0.5 Buzz (gpt-5-nano), winner-pick ≈ 20–40 Buzz/challenge (gpt-4o-mini vision). House cut is self-funding; do NOT add review caps or escrow — track spend only.
- **DB access:** `dbRead` for reads, `dbWrite` for writes. Logging: `logToAxiom` from `~/server/logging/client`. Concurrency: `limitConcurrency(tasks, n)`.
- **Commit after every task.** Conventional commits, scope `challenges`. End commit messages with the Co-Authored-By trailer.

---

# PHASE 1 — CRITICAL

Blocks a correct public launch. Ship + verify before widening `userChallenges`.

## Task 1: Job concurrency + batch-size constants

**Files:**
- Modify: `src/shared/constants/challenge.constants.ts`
- Test: `src/shared/constants/__tests__/challenge.constants.test.ts` (create if absent; else colocate with existing challenge constant tests)

**Interfaces:**
- Produces: `CHALLENGE_JOB_CONCURRENCY: number` (5), `CHALLENGE_JOB_BATCH_SIZE: number` (200), `CHALLENGE_REVIEW_BUZZ_ESTIMATE: number` (1) — consumed by Tasks 3–10.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  CHALLENGE_JOB_CONCURRENCY,
  CHALLENGE_JOB_BATCH_SIZE,
  CHALLENGE_REVIEW_BUZZ_ESTIMATE,
} from '~/shared/constants/challenge.constants';

describe('challenge job constants', () => {
  it('caps concurrency conservatively', () => {
    expect(CHALLENGE_JOB_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(CHALLENGE_JOB_CONCURRENCY).toBeLessThanOrEqual(10);
  });
  it('bounds per-run batch size', () => {
    expect(CHALLENGE_JOB_BATCH_SIZE).toBeGreaterThanOrEqual(50);
  });
  it('exposes a positive per-review buzz estimate for metrics', () => {
    expect(CHALLENGE_REVIEW_BUZZ_ESTIMATE).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/constants/__tests__/challenge.constants.test.ts`
Expected: FAIL — constants not exported.

- [ ] **Step 3: Add the constants**

Append to `src/shared/constants/challenge.constants.ts`:

```ts
/** Max challenges processed concurrently inside a single job run. Bounded by DB load + OpenRouter rate limits. */
export const CHALLENGE_JOB_CONCURRENCY = 5;
/** Max challenges a single job run pulls from a selector. Remaining work rolls to the next tick. */
export const CHALLENGE_JOB_BATCH_SIZE = 200;
/** Rough per-entry review cost in Buzz (gpt-5-nano, ~0.5 Buzz) used only for the spend-vs-housecut metric. */
export const CHALLENGE_REVIEW_BUZZ_ESTIMATE = 1;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/shared/constants/__tests__/challenge.constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants/challenge.constants.ts src/shared/constants/__tests__/challenge.constants.test.ts
git commit -m "feat(challenges): job concurrency + batch-size constants"
```

---

## Task 2: Batched challenge loader (kill the getChallengeById N+1)

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts`
- Test: `src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts` (existing)

**Interfaces:**
- Consumes: existing `getChallengeById(id)` shape (its returned `Challenge` object) — the batched loader returns the SAME object shape per id.
- Produces: `getChallengesByIds(ids: number[]): Promise<Challenge[]>` — one set-based query returning the same hydrated shape `getChallengeById` returns, order not guaranteed (callers map by id). Consumed by Tasks 3–5.

**Context:** `getChallengeById` (`challenge-helpers.ts` ~:120-150) runs 4 correlated cover-image subqueries per call; selectors currently do `Promise.all(ids.map(getChallengeById))`. Read the real `getChallengeById` body first and mirror its `select`/hydration exactly so downstream consumers are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getChallengesByIds } from '~/server/games/daily-challenge/challenge-helpers';

describe('getChallengesByIds', () => {
  it('is exported and returns an array', async () => {
    expect(typeof getChallengesByIds).toBe('function');
  });
  it('returns empty array for empty input without hitting the db', async () => {
    await expect(getChallengesByIds([])).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts -t getChallengesByIds`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the batched loader**

In `challenge-helpers.ts`, add a `getChallengesByIds` that reproduces `getChallengeById`'s selection but with `WHERE id = ANY(${ids})` (single query). Early-return `[]` when `ids.length === 0`. Reuse the same cover-image hydration `getChallengeById` uses (lift it into a shared internal helper if it's inline, so both paths share it — DRY). Keep `getChallengeById` as a thin wrapper: `const [row] = await getChallengesByIds([id]); return row ?? null;` if the shapes match cleanly; otherwise leave `getChallengeById` and just share the select fragment.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts -t getChallengesByIds`
Expected: PASS.

- [ ] **Step 5: Typecheck the touched file**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/games/daily-challenge/challenge-helpers.ts src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts
git commit -m "perf(challenges): batched getChallengesByIds loader to kill selector N+1"
```

---

## Task 3: Bound + order all job selectors; use the batched loader

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts`
- Test: `src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts`

**Interfaces:**
- Consumes: `getChallengesByIds` (Task 2), `CHALLENGE_JOB_BATCH_SIZE` (Task 1).
- Produces: bounded versions of `getActiveChallengesFromDb`, `getEndedActiveChallengesFromDb`, `getScheduledChallengesReadyToStart`, `getChallengesToReconcileFromDb`, `getUnscannedUserChallengesPastStart` — each `LIMIT CHALLENGE_JOB_BATCH_SIZE`, stable `ORDER BY`, and `Promise.all(map(getChallengeById))` replaced with `getChallengesByIds`.

**Context:** `getActiveChallengesFromDb` currently has `LIMIT 50` (`challenge-helpers.ts:221`) — a **silent drop** of the 51st+ active challenge. Raise to `CHALLENGE_JOB_BATCH_SIZE`, keep a stable order so the same challenges aren't perpetually starved. The others have NO limit — add `LIMIT CHALLENGE_JOB_BATCH_SIZE` + `ORDER BY` on an immutable/monotonic key (`endsAt ASC` for ended/reconcile, `startsAt ASC` for scheduled/unscanned, `id ASC` tiebreak).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import * as helpers from '~/server/games/daily-challenge/challenge-helpers';
import { CHALLENGE_JOB_BATCH_SIZE } from '~/shared/constants/challenge.constants';

describe('bounded selectors', () => {
  it('no selector uses a hardcoded LIMIT 50', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync(require.resolve('~/server/games/daily-challenge/challenge-helpers'), 'utf8').catch?.() ?? ''
    ).catch(() => '');
    // Behavioral assertion instead of source scraping: batch size constant is imported/used.
    expect(CHALLENGE_JOB_BATCH_SIZE).toBeGreaterThan(50);
  });
});
```

> Note: the source-scrape above is unreliable across bundlers; the real verification is the integration test in Task 4 (seed >50 active challenges, assert all processed). Keep this test minimal — its job is to lock the constant relationship. If the implementer prefers, replace with a direct call to a selector against a seeded test DB following the existing `*.sysredis-soft.test.ts` pattern.

- [ ] **Step 2: Run test to verify it fails / passes trivially**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts -t "bounded selectors"`
Expected: PASS once Task 1 is in (this task's real proof is Task 4's integration test).

- [ ] **Step 3: Edit each selector**

For each of the five selectors: add `ORDER BY <stable key> LIMIT ${CHALLENGE_JOB_BATCH_SIZE}`; replace the `Promise.all(rows.map((r) => getChallengeById(r.id)))` tail with `getChallengesByIds(rows.map((r) => r.id))`. Preserve existing `WHERE` clauses exactly (status filters, `source != 'User' OR ingestion = 'Scanned'`, grace-period logic). Read each selector body before editing.

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-helpers.ts src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts
git commit -m "fix(challenges): bound + order job selectors, drop silent LIMIT 50 active cap"
```

---

## Task 4: Concurrency in the review job + no-drop integration test

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` (`reviewEntries`, ~:540-565)
- Test: `src/server/jobs/__tests__/challenge-jobs-scale.test.ts` (create)

**Interfaces:**
- Consumes: `limitConcurrency` (`~/server/utils/concurrency-helpers`), `CHALLENGE_JOB_CONCURRENCY` (Task 1), bounded `getActiveChallenges` (Task 3).

**Context:** `reviewEntries` loops active challenges with a serial `for...of` (`:558`). Replace with `limitConcurrency` at `CHALLENGE_JOB_CONCURRENCY`, keep the existing per-challenge try/catch + `logToAxiom` error isolation intact (one failure must not abort others). Log a warning when the active-challenge count equals the batch ceiling (visible truncation).

- [ ] **Step 1: Write the failing test**

Follow the existing job-test pattern (mock the selectors + `reviewEntriesForChallenge`). Seed 120 fake active challenges; assert every one is passed to `reviewEntriesForChallenge` and that a thrown error in one does not prevent the others.

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (orig) => {
  const actual = await orig<any>();
  const challenges = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, source: 'User' }));
  return { ...actual, getActiveChallenges: vi.fn(async () => challenges) };
});

const processed: number[] = [];
vi.mock('~/server/games/daily-challenge/daily-challenge-processing-impl', () => ({}));

describe('reviewEntries at volume', () => {
  it('processes every active challenge and isolates failures', async () => {
    // Import after mocks; spy on reviewEntriesForChallenge to record ids + throw on one.
    const mod = await import('~/server/jobs/daily-challenge-processing');
    const spy = vi
      .spyOn(mod, 'reviewEntriesForChallenge' as any)
      .mockImplementation(async (c: any) => {
        if (c.id === 7) throw new Error('boom');
        processed.push(c.id);
      });
    await (mod as any).reviewEntries();
    expect(processed).toHaveLength(119); // all except the one that threw
    expect(processed).toContain(120);   // the 120th is NOT dropped
    spy.mockRestore();
  });
});
```

> The implementer must adapt mock target names to the real exports (read `daily-challenge-processing.ts` for the exact `reviewEntriesForChallenge`/`getActiveChallenges` symbols). The assertions (all processed, failure isolated, 120th not dropped) are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/jobs/__tests__/challenge-jobs-scale.test.ts -t "reviewEntries at volume"`
Expected: FAIL — 120th dropped (old LIMIT 50) or serial loop aborts on the throw.

- [ ] **Step 3: Implement concurrency + ceiling log**

Replace the serial loop with:

```ts
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { CHALLENGE_JOB_CONCURRENCY, CHALLENGE_JOB_BATCH_SIZE } from '~/shared/constants/challenge.constants';

const activeChallenges = await getActiveChallenges();
if (activeChallenges.length >= CHALLENGE_JOB_BATCH_SIZE) {
  await logToAxiom({
    name: 'daily-challenge-process-entries',
    type: 'warning',
    message: 'active-challenge batch ceiling hit; remaining roll to next tick',
    count: activeChallenges.length,
  });
}
await limitConcurrency(
  activeChallenges.map((challenge) => async () => {
    try {
      await reviewEntriesForChallenge(challenge /* + existing args */);
    } catch (e) {
      await logToAxiom({ name: 'daily-challenge-process-entries', type: 'error', challengeId: challenge.id, message: (e as Error).message });
    }
  }),
  CHALLENGE_JOB_CONCURRENCY
);
```

Match `limitConcurrency`'s actual signature (read `concurrency-helpers.ts:15`) and preserve any args `reviewEntriesForChallenge` needs.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/jobs/__tests__/challenge-jobs-scale.test.ts -t "reviewEntries at volume"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/server/jobs/daily-challenge-processing.ts src/server/jobs/__tests__/challenge-jobs-scale.test.ts
git commit -m "fix(challenges): concurrent bounded review loop, no silent challenge drop"
```

---

## Task 5: Concurrency in completion (winner-pick) + reconcile loops

**Files:**
- Modify: `src/server/jobs/challenge-completion.ts`
- Test: `src/server/jobs/__tests__/challenge-jobs-scale.test.ts` (extend)

**Interfaces:**
- Consumes: `limitConcurrency`, `CHALLENGE_JOB_CONCURRENCY`, bounded `getEndedActiveChallenges` / `getChallengesToReconcile` (Task 3).

**Context:** `challenge-completion.ts:32` and `:53` are serial `for...of` loops, each doing an LLM `generateWinners` per challenge. Winner-pick is already claim-guarded (`claimChallengeForCompletion`) so concurrency is safe. Wrap both loops in `limitConcurrency`; keep per-challenge try/catch + `logToAxiom`.

- [ ] **Step 1: Write the failing test**

Extend the scale test: seed 60 ended challenges, spy on `pickWinnersForChallenge`, throw on one, assert the other 59 still complete.

```ts
describe('completion at volume', () => {
  it('picks winners for every ended challenge, isolating failures', async () => {
    const done: number[] = [];
    // mock getEndedActiveChallenges -> 60 challenges; spy pickWinnersForChallenge
    // throw on id 3; assert done.length === 59 and includes id 60.
    expect(true).toBe(true); // replace with real assertions per the reviewEntries pattern
  });
});
```

> Implement the real mocks mirroring Task 4. The contract: all ended challenges processed, one failure isolated.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/jobs/__tests__/challenge-jobs-scale.test.ts -t "completion at volume"`
Expected: FAIL (serial loop aborts on throw / not concurrent).

- [ ] **Step 3: Implement**

Replace both `for...of` loops with `limitConcurrency(..., CHALLENGE_JOB_CONCURRENCY)`, preserving the existing try/catch + `logToAxiom` bodies verbatim inside each task thunk.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/jobs/__tests__/challenge-jobs-scale.test.ts -t "completion at volume"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm run typecheck`

```bash
git add src/server/jobs/challenge-completion.ts src/server/jobs/__tests__/challenge-jobs-scale.test.ts
git commit -m "fix(challenges): concurrent winner-pick + reconcile loops"
```

---

## Task 6: Concurrency + conditional-write safety in activation

**Files:**
- Modify: `src/server/jobs/challenge-activation.ts`, `src/server/games/daily-challenge/challenge-helpers.ts` (`setChallengeActive`)
- Test: `src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts`

**Interfaces:**
- Consumes: `limitConcurrency`, `CHALLENGE_JOB_CONCURRENCY`.
- Produces: `setChallengeActive` becomes a conditional write (`updateMany where status = 'Scheduled'`) returning whether it activated — idempotent under overlapping ticks.

**Context:** activation has two serial phases (void-unscanned, activate-ready) with no concurrency and no claim guard. Make `setChallengeActive` a conditional `updateMany({ where: { id, status: 'Scheduled' }, data: { status: 'Active', ... } })`; if `count === 0`, a concurrent tick already activated it → skip the rest of that challenge's side effects. Then wrap both phases in `limitConcurrency`.

- [ ] **Step 1: Write the failing test**

```ts
describe('setChallengeActive idempotency', () => {
  it('activates only from Scheduled and is a no-op on second call', async () => {
    // Against seeded test DB (follow *.sysredis-soft.test.ts pattern):
    // create a Scheduled challenge; call setChallengeActive twice;
    // assert first returns activated=true, second returns activated=false,
    // and status ends Active exactly once (no duplicate side effects).
    expect(true).toBe(true); // replace with real DB-backed assertions
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts -t "setChallengeActive idempotency"`
Expected: FAIL — current `setChallengeActive` unconditionally writes.

- [ ] **Step 3: Implement conditional write + concurrency**

Convert `setChallengeActive` to `updateMany` guarded on `status: 'Scheduled'`, return `{ activated: boolean }`. In `challenge-activation.ts`, wrap both phases with `limitConcurrency(..., CHALLENGE_JOB_CONCURRENCY)`, keep per-challenge try/catch + `logToAxiom`, and only run activation side effects when `activated === true`.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts -t "setChallengeActive idempotency"`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/challenge-activation.ts src/server/games/daily-challenge/challenge-helpers.ts src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts
git commit -m "fix(challenges): concurrent activation with conditional-write idempotency"
```

---

## Task 7: Surface LLM token usage from the OpenRouter client

**Files:**
- Modify: `src/server/services/ai/openrouter.ts`
- Test: `src/server/services/ai/__tests__/openrouter-usage.test.ts` (create)

**Interfaces:**
- Produces: the client's completion call returns/exposes `usage?: { promptTokens: number; completionTokens: number }` alongside the parsed content, so callers can compute cost. Consumed by Task 8.

**Context:** OpenRouter chat responses include a `usage` object. Read `openrouter.ts` (~:120-200, the completion helpers) and thread `usage` through the return value without breaking existing callers (add an optional field / return tuple; keep the current content return the default).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { extractUsage } from '~/server/services/ai/openrouter';

describe('extractUsage', () => {
  it('maps OpenRouter usage to promptTokens/completionTokens', () => {
    const usage = extractUsage({ usage: { prompt_tokens: 1200, completion_tokens: 300 } } as any);
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 300 });
  });
  it('returns zeros when usage is absent', () => {
    expect(extractUsage({} as any)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/ai/__tests__/openrouter-usage.test.ts`
Expected: FAIL — `extractUsage` not exported.

- [ ] **Step 3: Implement `extractUsage` + thread usage through**

Add and export `extractUsage(resp)` mapping `resp.usage.prompt_tokens`/`completion_tokens` → `{ promptTokens, completionTokens }` (zeros when missing). Have the completion helper return usage (e.g. `{ content, usage }`) or attach it; update internal callers minimally.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/services/ai/__tests__/openrouter-usage.test.ts`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/services/ai/openrouter.ts src/server/services/ai/__tests__/openrouter-usage.test.ts
git commit -m "feat(challenges): expose OpenRouter token usage for spend tracking"
```

---

## Task 8: Accumulate operationSpent + spend-vs-housecut metric

**Files:**
- Modify: `src/server/games/daily-challenge/generative-content.ts` (return usage from `generateReview`, `generateWinners`), `src/server/jobs/daily-challenge-processing.ts` (accumulate + metric)
- Test: `src/server/games/daily-challenge/__tests__/challenge-spend.test.ts` (create)

**Interfaces:**
- Consumes: `extractUsage` (Task 7), model rates.
- Produces: `estimateBuzzCost(model: string, usage): number` (pure) — consumed by the jobs; `Challenge.operationSpent` incremented atomically per review/winner-pick; Axiom `challenge-llm-spend` metric emitted at completion.

**Context:** `operationSpent` column exists and is currently unused. Convert token usage → USD via model rates (gpt-5-nano: 0.05/0.40 per M; gpt-4o-mini: 0.15/0.60 per M) → Buzz (×1000). Increment `Challenge.operationSpent` with `{ increment }`. At completion, emit `logToAxiom({ name: 'challenge-llm-spend', challengeId, source, operationSpent, houseCutCollected })`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { estimateBuzzCost } from '~/server/games/daily-challenge/generative-content';

describe('estimateBuzzCost', () => {
  it('prices gpt-5-nano review in buzz', () => {
    // 4000 in @ $0.05/M + 500 out @ $0.40/M = 0.0002 + 0.0002 = $0.0004 -> 0.4 buzz
    const buzz = estimateBuzzCost('openai/gpt-5-nano', { promptTokens: 4000, completionTokens: 500 });
    expect(buzz).toBeCloseTo(0.4, 5);
  });
  it('prices gpt-4o-mini higher', () => {
    const buzz = estimateBuzzCost('openai/gpt-4o-mini', { promptTokens: 4000, completionTokens: 500 });
    expect(buzz).toBeGreaterThan(estimateBuzzCost('openai/gpt-5-nano', { promptTokens: 4000, completionTokens: 500 }));
  });
  it('returns 0 for unknown models', () => {
    expect(estimateBuzzCost('unknown/model', { promptTokens: 1000, completionTokens: 1000 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-spend.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add `MODEL_BUZZ_RATES` (input/output $/M per model) + `estimateBuzzCost(model, usage)` (pure, returns Buzz; 0 for unknown). Have `generateReview`/`generateWinners` return their `usage`. In the jobs, after each LLM call, `dbWrite.challenge.update({ where: { id }, data: { operationSpent: { increment: Math.ceil(estimateBuzzCost(model, usage)) } } })`. Emit the `challenge-llm-spend` metric in the completion path with `houseCutCollected` (sum of house-cut legs for the challenge, or `entryCount * CHALLENGE_ENTRY_HOUSE_CUT`).

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-spend.test.ts`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/generative-content.ts src/server/jobs/daily-challenge-processing.ts src/server/games/daily-challenge/__tests__/challenge-spend.test.ts
git commit -m "feat(challenges): track LLM spend in operationSpent + spend-vs-housecut metric"
```

---

## Task 9: Cheapen winner-pick vision cost

**Files:**
- Modify: `src/server/games/daily-challenge/generative-content.ts` (`generateWinners` image content, ~:408)
- Test: covered by Task 8's typecheck + a unit assertion on the message builder if one exists; otherwise manual verification note.

**Interfaces:**
- Consumes: existing `generateWinners` image message construction.

**Context:** winner-pick sends top-10 full images to gpt-4o-mini — the ~20–40 Buzz driver. Send `detail: 'low'` on the winner-pick `image_url` content (per-entry review keeps full detail — it's the accuracy pass and cheap on gpt-5-nano). This collapses winner-pick vision to ~flat 85 tokens/image.

- [ ] **Step 1: Add `detail: 'low'` to winner-pick images**

In `generateWinners`, change the image content items to `{ type: 'image_url', image_url: { url, detail: 'low' } }`. Confirm the `ImageContent` type in `openrouter.ts:39` allows `detail`; if not, extend it to `{ type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }` and pass it through the transform at `openrouter.ts:92-93`.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Manual cost check (documented, not automated)**

Add a one-line comment at the change site noting the rationale + spec section C2, and record in the PR description that winner quality on low-detail must be validated on a sample before wide launch (spec open question).

- [ ] **Step 4: Commit**

```bash
git add src/server/games/daily-challenge/generative-content.ts src/server/services/ai/openrouter.ts
git commit -m "perf(challenges): low-detail vision for winner-pick to cut LLM cost ~20x"
```

---

## Task 10: Skip LLM winner-pick for degenerate (<2 entrant) challenges

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` (`pickWinnersForChallenge`, ~:1149-1290)
- Test: `src/server/games/daily-challenge/__tests__/challenge-degenerate-winners.test.ts` (create)

**Interfaces:**
- Consumes: existing judged-entries query.

**Context:** paying 20–40 Buzz to LLM-pick a winner among <2 distinct entrants is wasteful and can exceed a single 25-Buzz house cut. When distinct entrant count `< 2`, skip `generateWinners`: if exactly 1 entrant with a valid entry, award them place-1 deterministically; if 0, take the existing zero-winner refund/complete path. Reuse existing award/refund functions — do not reimplement payout.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';

describe('pickWinnersForChallenge degenerate guard', () => {
  it('does not call generateWinners when fewer than 2 distinct entrants', async () => {
    // mock judged entries to a single entrant; spy generateWinners; assert not called
    // and that the single entrant is awarded place 1 via the existing award fn.
    expect(true).toBe(true); // replace with real spies per repo pattern
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-degenerate-winners.test.ts`
Expected: FAIL — `generateWinners` still called.

- [ ] **Step 3: Implement the guard**

Before the `generateWinners` call in `pickWinnersForChallenge`, compute distinct entrant count from the judged entries. If `< 2`: branch to deterministic single-winner award (place-1 payout via the existing winner-payout path) or the existing zero-winner completion. Keep the `Completing` claim + status transition unchanged.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/games/daily-challenge/__tests__/challenge-degenerate-winners.test.ts`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/daily-challenge-processing.ts src/server/games/daily-challenge/__tests__/challenge-degenerate-winners.test.ts
git commit -m "fix(challenges): skip costly LLM winner-pick for <2-entrant challenges"
```

---

# PHASE 2 — IMPORTANT

Money leaks / correctness-for-users / trust. Ship before wide launch.

## Task 11: Validate required resource at submit (stop the off-resource fee leak)

**Files:**
- Modify: `src/server/services/collection.service.ts` (`validateContestCollectionEntry`, ~:1936-2215)
- Test: `src/server/services/__tests__/contest-entry-resource-gate.test.ts` (create)

**Interfaces:**
- Consumes: `ImageResourceNew` (existing table), the challenge's `modelVersionIds`.

**Context:** resource requirement is enforced at promotion (`challenge-rewards.ts:38-66`) AFTER the fee is charged; off-resource entries are charged then auto-rejected with no refund. Add a pre-charge check in `validateContestCollectionEntry`: when the linked challenge has non-empty `modelVersionIds`, require `EXISTS (SELECT 1 FROM "ImageResourceNew" WHERE "imageId" = ? AND "modelVersionId" = ANY(?))`; throw a bad-request (no charge) if absent. Place it BEFORE the entry-fee charge block (~:2197), alongside the existing NSFW/window gates.

- [ ] **Step 1: Write the failing test**

```ts
describe('contest entry resource gate', () => {
  it('rejects an image lacking any required modelVersionId before charging', async () => {
    // seed a User challenge with modelVersionIds=[X]; an image without X;
    // expect validateContestCollectionEntry to throw and NO entry-fee charge to occur.
    expect(true).toBe(true); // replace with real seed + spy on chargeContestEntryFeesForCollection
  });
  it('accepts an image that has one of the required versions', async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/contest-entry-resource-gate.test.ts`
Expected: FAIL — no pre-charge resource gate.

- [ ] **Step 3: Implement the gate**

Add the `EXISTS ImageResourceNew` check for resource-restricted challenges before the fee charge; throw `throwBadRequestError('This image does not use a required model for this challenge.')`. Keep the promotion-time check as defense-in-depth.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/services/__tests__/contest-entry-resource-gate.test.ts`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/services/collection.service.ts src/server/services/__tests__/contest-entry-resource-gate.test.ts
git commit -m "fix(challenges): validate required resource at submit to stop off-resource fee leak"
```

---

## Task 12: Cover-image scan gate before public visibility

**Files:**
- Modify: `src/server/services/challenge.service.ts` (feed `getInfiniteChallenges` ~:381-396, detail `getChallengeDetail` ~:859-886), optionally `src/server/games/daily-challenge/challenge-visibility.ts`
- Test: `src/server/games/daily-challenge/challenge-visibility.test.ts` (existing) or a new service test

**Interfaces:**
- Consumes: `Image.ingestion` / `scannedAt`.

**Context:** feed/detail gate on text `ingestion='Scanned'` + `coverImageId NOT NULL` + POI, but NOT on cover-image scan state. Add: cover image must be `Image.ingestion = 'Scanned'` (and not `Blocked`) for non-creator visibility. Add the join/condition to both queries' non-creator branch. Creator still sees pre-scan.

- [ ] **Step 1: Write the failing test**

If a pure helper is extractable (e.g. `isChallengeCoverScanned(challenge)` in `challenge-visibility.ts`), TDD it:

```ts
import { isChallengeCoverScanned } from '~/server/games/daily-challenge/challenge-visibility';

describe('isChallengeCoverScanned', () => {
  it('false when cover image not yet scanned', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Pending' } } as any)).toBe(false);
  });
  it('true when cover image scanned and not blocked', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Scanned' } } as any)).toBe(true);
  });
  it('false when blocked', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Blocked' } } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-visibility.test.ts -t isChallengeCoverScanned`
Expected: FAIL — helper not defined.

- [ ] **Step 3: Implement helper + wire into feed/detail SQL**

Add `isChallengeCoverScanned`; add the equivalent SQL condition to the non-creator branch of both queries (join `Image` on `coverImageId`, require `ingestion = 'Scanned'`). Ensure the activation gate (`source != 'User' OR ingestion='Scanned'`, Task 3 selectors) still lets activation proceed — visibility is separate from activation.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-visibility.test.ts -t isChallengeCoverScanned`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/services/challenge.service.ts src/server/games/daily-challenge/challenge-visibility.ts src/server/games/daily-challenge/challenge-visibility.test.ts
git commit -m "fix(challenges): gate public visibility on cover-image scan completion"
```

---

## Task 13: Entrant notification on challenge cancel/refund

**Files:**
- Modify: `src/server/notifications/challenge.notifications.ts`, `src/server/services/challenge.service.ts` (`voidChallenge` ~:2256-2295, zero-winner refund path)
- Test: `src/server/notifications/__tests__/challenge-cancelled-notification.test.ts` (create) — assert the notification definition exists + renders

**Interfaces:**
- Produces: `challenge-cancelled` notification type in the registry.

**Context:** `voidChallenge` refunds entrants silently (no notification). Add a `challenge-cancelled` notification (registry pattern like `challenge-winner`), sent to every distinct entrant on void + zero-winner refund, stating the challenge was cancelled and the pool portion refunded (be honest: house cut retained). Batch-insert.

- [ ] **Step 1: Write the failing test**

```ts
import { challengeNotifications } from '~/server/notifications/challenge.notifications';

describe('challenge-cancelled notification', () => {
  it('is registered and renders a message', () => {
    const def = (challengeNotifications as any)['challenge-cancelled'];
    expect(def).toBeTruthy();
    const msg = def.prepareMessage({ details: { challengeTitle: 'X', refundedBuzz: 100 } });
    expect(msg.message).toContain('X');
  });
});
```

Match the real registry export name/shape (read `challenge.notifications.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/notifications/__tests__/challenge-cancelled-notification.test.ts`
Expected: FAIL — type not registered.

- [ ] **Step 3: Implement the notification + emit on void/refund**

Add the `challenge-cancelled` definition (`toggleable: false`, mirrors `challenge-winner`). In `voidChallenge` and the zero-winner refund branch, after refunds succeed, collect distinct entrant userIds and `createNotification` (bulk) with `{ challengeTitle, refundedBuzz }`.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm vitest run src/server/notifications/__tests__/challenge-cancelled-notification.test.ts`
Run: `pnpm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/server/notifications/challenge.notifications.ts src/server/services/challenge.service.ts src/server/notifications/__tests__/challenge-cancelled-notification.test.ts
git commit -m "feat(challenges): notify entrants when a challenge they entered is cancelled/refunded"
```

---

## Task 14: Audit + fix "current challenge" singletons

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts` (`setChallengeActive` DETAILS write), and/or `daily-challenge.utils.ts`, `packages/civitai-redis` key defs — depending on audit outcome
- Test: n/a (audit-driven); add a comment documenting the decision

**Context:** `REDIS_KEYS.DAILY_CHALLENGE.DETAILS` is last-writer-wins on every `setChallengeActive`; `getCurrentChallenge`/`getActiveChallengeFromDb` are `LIMIT 1`. First **audit readers**.

- [ ] **Step 1: Audit who reads `DAILY_CHALLENGE.DETAILS` and `getCurrentChallenge`**

Run:
```bash
rg -n "DAILY_CHALLENGE.DETAILS|getCurrentChallenge|getActiveChallengeFromDb|getCurrentDailyChallenge" src/ packages/
```
Record every reader in the commit message / PR notes.

- [ ] **Step 2: Decide + implement**

- If nothing meaningfully reads `DETAILS`: remove the write in `setChallengeActive` (dead write). Else namespace it `daily-challenge:details:{id}`.
- If `getCurrentDailyChallenge`/`cycle.ts` are strictly legacy daily/mod paths (not reachable for user challenges): leave them, add a one-line comment noting they intentionally see only the newest active challenge. If reachable on a public path: replace with an explicit `getChallengeById`/id-scoped lookup.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm run typecheck`

```bash
git add -A
git commit -m "fix(challenges): scope/retire single-current-challenge singletons for multi-challenge safety"
```

---

# PHASE 3 — MINOR

Hardening/polish. Each independent.

## Task 15: Per-user challenge-create rate limit

**Files:**
- Modify: `src/server/services/challenge-eligibility.service.ts` (`assertCanCreateUserChallenge`), `src/shared/constants/challenge.constants.ts`
- Test: `src/server/services/__tests__/challenge-create-rate-limit.test.ts` (create)

**Context:** only a concurrent cap exists; create→delete churn is free. Add `CHALLENGE_CREATE_DAILY_LIMIT` (e.g. 5) and reject creation when the user created ≥ limit user challenges in the last 24h (`count where createdById=? AND source='User' AND createdAt > now()-24h`).

- [ ] **Step 1: Failing test** — assert `assertCanCreateUserChallenge` throws when the recent-create count is at the limit (mock the count).
- [ ] **Step 2: Run** `pnpm vitest run src/server/services/__tests__/challenge-create-rate-limit.test.ts` → FAIL.
- [ ] **Step 3:** add constant + the 24h-count check in `assertCanCreateUserChallenge`.
- [ ] **Step 4:** rerun → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(challenges): daily per-user challenge-create rate limit`.

## Task 16: Scan the `invitation` field

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts` (`buildChallengeModerationText`, ~:38-46)
- Test: `src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts`

**Context:** `invitation` is validated (max 300) but excluded from moderation text.

- [ ] **Step 1: Failing test** — `buildChallengeModerationText({ title, theme, description, invitation })` includes the invitation text.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3:** append `invitation` to the assembled text.
- [ ] **Step 4:** rerun → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** commit `fix(challenges): include invitation field in moderation scan`.

## Task 17: Re-check creator eligibility on edit

**Files:**
- Modify: `src/server/services/challenge.service.ts` (`upsertUserChallenge` edit branch, ~:1399-1507)
- Test: `src/server/services/__tests__/challenge-edit.service.test.ts` (existing)

**Context:** `assertUserInGoodStanding` runs only on create (`!id`). A since-muted/struck user can still edit a Scheduled challenge. Call `assertUserInGoodStanding(userId)` on the edit branch too (NOT the score/tier-cap create-only checks — just standing).

- [ ] **Step 1: Failing test** — editing while muted/struck throws.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3:** add `assertUserInGoodStanding` to the edit path.
- [ ] **Step 4:** rerun → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** commit `fix(challenges): re-check creator standing on challenge edit`.

## Task 18: Challenge report reason for ownership/impersonation

**Files:**
- Modify: `src/components/Report/ReportModal.tsx` (reason lists ~:82,105,140) + any report-reason schema for `ReportEntity.Challenge`
- Test: n/a (UI config) — verify via typecheck + a snapshot/enum test if one exists

**Context:** Challenge reports offer only AdminAttention/NSFW/Spam. Add an ownership/impersonation reason (cover/theme are user-supplied). Reuse the existing `Ownership` report reason if the enum already has it; just add `ReportEntity.Challenge` to its allowed-entities list.

- [ ] **Step 1:** add Challenge to the ownership/impersonation reason's entity list.
- [ ] **Step 2:** `pnpm run typecheck`.
- [ ] **Step 3:** commit `feat(challenges): add ownership/impersonation report reason for challenges`.

## Task 19: Map winner by entry id, not creator name

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` (winner mapping ~:1299-1315)
- Test: `src/server/games/daily-challenge/__tests__/challenge-winner-mapping.test.ts` (create)

**Context:** winners are matched from LLM output by `creator`/`creatorId` string. Prefer having `generateWinners` return the chosen entry's id/imageId and map back by that id; fall back to name only if id absent. Defense-in-depth against user-controlled names.

- [ ] **Step 1: Failing test** — mapping resolves the winner by entry id even when two entrants share a display name.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3:** thread entry id through `generateWinners` output + map by id.
- [ ] **Step 4:** rerun → PASS; `pnpm run typecheck`.
- [ ] **Step 5:** commit `fix(challenges): map winners by entry id to harden against name spoofing`.

## Task 20: Formalize partial-winner keep-in-house

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` (`challenge-partial-winner-residual` log ~:1364-1382)

**Context:** decision is keep-in-house; buzz already sits in account 0. Downgrade the residual `logToAxiom` from warning to info/metric and add a one-line comment referencing the spec decision so it reads as intended behavior.

- [ ] **Step 1:** change the log `type` to info/metric + add the comment.
- [ ] **Step 2:** `pnpm run typecheck`.
- [ ] **Step 3:** commit `chore(challenges): mark partial-winner residual as intended keep-in-house`.

---

# Final: open the PR

After all tasks:

- [ ] Run the full challenge test suite: `pnpm vitest run src/server/games/daily-challenge src/server/jobs/__tests__ src/server/services/__tests__ src/server/notifications/__tests__`
- [ ] `pnpm run typecheck` (must complete, 8GB heap — confirm it finished, not OOM).
- [ ] Push the branch and open a PR **against `feat/public-challenges`** (NOT main) titled "Public challenges: production readiness (jobs, economics, money leaks, moderation)". Body summarizes the three phases, links the spec, and flags the two open validation items (winner-pick low-detail quality; `DETAILS` reader audit outcome).

## Self-Review Notes

- **Spec coverage:** C1→Tasks 2–6; C2→Tasks 1,7–10; I1→11; I2→12; I3→13; I4→14; M1→15; M2→16; M3→17; M4→18; M5→19; M6→20. Production-readiness (monitoring/testing/rollout)→folded into Task 8 metric + Final. All spec sections mapped.
- **No new columns/tables** — reuses `operationSpent`. No migration expected; Final step verifies typecheck.
- **Type consistency:** `getChallengesByIds` (Task 2) consumed in Task 3; `extractUsage` (7) → `estimateBuzzCost` (8); `CHALLENGE_JOB_CONCURRENCY`/`BATCH_SIZE` (1) → Tasks 3–6. Names consistent.
- **Test caveat:** several job/service tests are DB/mizmock-heavy; where full TDD code couldn't be pinned without the live symbol names, the task states the exact behavioral contract the implementer must assert and points at the existing pattern file. Implementers read the real file first.
