# PR Review: Creator Program Pool Unification + Environment Swap

## Overview

This PR unifies the yellow/green compensation pools into a single pool and adds environment-swap UI (NSFW redirect to civitai.red, pricing banners, plan card redesign).

---

## Open Concerns

### 1. Distribution job — `externalTransactionId` format change

**File:** [creators-program-jobs.ts](../src/server/jobs/creators-program-jobs.ts)

Old format: `comp-pool-${monthStr}-${userId}-${buzzType}`
New format: `comp-pool-unified-${monthStr}-${userId}`

If this job runs during a transition month where the old format was already used for one buzz type, the new unified ID won't collide with the old per-type IDs. This means a user could theoretically receive both a per-type and a unified payout for the same month. In practice the risk is very low — the job runs on the last day of the month and advances the month state atomically via `dbKV`, so reprocessing a month would only happen if the old code partially ran and crashed before advancing.

**Status:** Accepted risk — no fix needed.

---

### 2. Low priority cleanup

- **`getBankAccountType` unused param** ([creator-program.service.ts](../src/server/services/creator-program.service.ts)): Takes `_buzzType?: BuzzSpendType` but always returns `'creatorProgramBank'`. Could remove param and update call sites.

---

## Pre-existing bugs fixed in this PR

### `extractingBuzz` returned mutation object instead of `.isLoading`

**File:** [CreatorProgram.util.ts:219](../src/components/Buzz/CreatorProgramV2/CreatorProgram.util.ts#L219)

Was returning the entire mutation object instead of `.isLoading`, meaning the extract button had no loading indicator and users could double-click. **Fixed.**

### `setToWithdraw(MIN_WITHDRAWAL_AMOUNT)` missing `/ 100`

**File:** [CreatorProgramV2.tsx:783](../src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx#L783)

After withdrawal, the input reset to raw cents instead of dollars. **Fixed.**

### `getPrevMonthStats` crashes on empty participants

**File:** [creator-program.service.ts:1038-1048](../src/server/services/creator-program.service.ts#L1038-L1048)

`cashedOutCreators[0].amount` throws if no one cashed out, and the error gets cached for `CacheTTL.month`. **Fixed** with `hasCashedOut` guard.

---

## Verified Non-Issues

- **`clearCacheByPattern` import** — Imported at line 33 from `cache-helpers.ts`.
- **`LIMIT 1` -> `LIMIT 1 BY id`** — Already fixed in this PR. Returns peak earning month per user correctly.
- **`reset-bank.ts` admin top-up from account 0** — userId=0 is the Civitai system account. Participant queries filter through `User` table which excludes it.
- **`dismissAlert` endpoint** — Exists at `user.router.ts:225` with schema and handler.
- **`MIN_CAP` import** — Modals file imports directly from `creator-program.constants`, not from the service.
- **Whitespace in modals** — Fixed by author.

---

## Copilot Concerns — All Non-Issues

| Concern | Status | Reason |
| ------- | ------ | ------ |
| `LIMIT 1` returns global peak instead of per-user | Already fixed | PR changed to `LIMIT 1 BY id` at line 123 |
| Division by zero in distribution job | Guarded | Line 60 early-returns when `pool.size.current <= 0` |
| `createBuzzTransactionMany` not awaited | Wrong | Line 88 clearly shows `await` |
| `getBanked` return type too broad | Wrong | Cast is already `Record<(typeof buzzBankTypes)[number], number>` |
| `reset-bank.ts` underfunding / userId=0 pollution | Wrong | Total comparison is correct; userId=0 is system account |
| Plan doc out of date | N/A | File doesn't exist in repo |
