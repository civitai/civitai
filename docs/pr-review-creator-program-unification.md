# PR Review: Creator Program Pool Unification + Environment Swap

## Overview

This PR unifies the yellow/green compensation pools into a single pool and adds environment-swap UI (NSFW redirect to civitai.red, pricing banners, plan card redesign).

---

## Concerns

### 1. `clearCacheByPattern` — is it imported?

**File:** [creator-program.service.ts](../src/server/services/creator-program.service.ts)

`bustCompensationPoolCache` calls `clearCacheByPattern(...)` to clean up legacy per-type cache keys, but it's not clear this function is imported or exists. If it's missing, the cache bust will throw at runtime.

**Action:** Verify `clearCacheByPattern` is imported and available from the cache utility module.

---

### 2. ClickHouse query: `LIMIT 1` -> `LIMIT 1 BY id`

**File:** [creator-program.service.ts](../src/server/services/creator-program.service.ts) — `createUserCapCache`

The cap query was changed from `LIMIT 1` to `LIMIT 1 BY id`. This is correct for returning one row **per user** (instead of one row total across all users in the batch), but:

- Was the old `LIMIT 1` actually a bug, or was it intentional because the query was already scoped to a single buzz type?
- With the unified pool now aggregating across yellow+green, `LIMIT 1 BY id` is necessary. But confirm the `ORDER BY earned DESC` still applies per-group (ClickHouse `LIMIT BY` respects the preceding `ORDER BY`).

**Action:** Verify the query returns the peak earning month per user, not just the global max.

---

### 3. Distribution job — `externalTransactionId` format change

**File:** [creators-program-jobs.ts](../src/server/jobs/creators-program-jobs.ts)

Old format: `comp-pool-${monthStr}-${userId}-${buzzType}`
New format: `comp-pool-unified-${monthStr}-${userId}`

If this job runs during a transition month where the old format was already used for one buzz type, the new unified ID won't collide with the old per-type IDs. This means a user could theoretically receive both a per-type and a unified payout for the same month.

**Action:** Confirm that either (a) the transition happens cleanly on a month boundary, or (b) there's a guard against double-distribution.

---

### 4. `MatureContentMigrationAlert` — `dismissAlert` endpoint

**File:** [MatureContentMigrationAlert.tsx](../src/components/Alerts/MatureContentMigrationAlert.tsx)

The component calls `trpc.user.dismissAlert.useMutation()`. This endpoint needs to exist and accept `{ alertId: string }`.

**Action:** Verify the `user.dismissAlert` tRPC route exists and handles the `alertId` parameter.

---

### 5. Whitespace-only lines where `type` prop was removed from `CurrencyIcon`

**File:** [CreatorProgramV2.modals.tsx](../src/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals.tsx) — lines ~316, ~322

When `type={activeBuzzType}` was removed, the lines were left with extra whitespace:

```tsx
<CurrencyIcon
  currency={Currency.BUZZ}
                          className="inline"
/>
```

This is cosmetic but should be cleaned up for consistency.

**Action:** Remove the extra whitespace on those lines.

---

### 6. `MIN_CAP` import removed from service but still referenced in modals

**File:** [creator-program.service.ts](../src/server/services/creator-program.service.ts) — `MIN_CAP` was removed from imports.

`CreatorProgramCapsInfo` in [CreatorProgramV2.modals.tsx](../src/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals.tsx) still references `MIN_CAP`. Verify it imports `MIN_CAP` from the constants file directly and doesn't depend on a re-export from the service.

**Action:** Confirm `MIN_CAP` is imported from `creator-program.constants` in the modals file.

---

### 7. Extraction fee edge case — zero-amount types

**File:** [creator-program.service.ts](../src/server/services/creator-program.service.ts) — `extractBuzz`

The proportional fee splitting uses `Math.floor` per type with last-type-gets-remainder. If a user has a tiny balance in one type (e.g., 1 yellow, 99999 green), the floor division assigns 0 to yellow and the full fee to green. This is mathematically correct but worth confirming it's the desired behavior (no minimum fee per type).

**Action:** Low priority — just confirm intent.

---

### 8. `getBankAccountType` still accepts `_buzzType` parameter

**File:** [creator-program.service.ts](../src/server/services/creator-program.service.ts)

`getBankAccountType` takes `_buzzType?: BuzzSpendType` but always returns `'creatorProgramBank'`. The parameter exists for backwards compat at call sites. Consider removing the parameter entirely and updating all call sites to make the unification intent explicit.

**Action:** Low priority cleanup.

---

### 9. `reset-bank.ts` — admin top-up uses `TransactionType.Bank` from account 0

**File:** [reset-bank.ts](../src/pages/api/mod/reset-bank.ts) — lines 66-74

When a mod resets a user's bank and the extraction exceeds the current pool balance, a top-up transaction is created with `fromAccountId: 0`, `TransactionType.Bank`. This could cause account 0 to appear as a "participant" in `getPoolParticipants` queries that aggregate bank transactions. The underfunding concern Copilot raised (per-type vs total comparison) is **not an issue** — the code correctly compares `totalToExtract` (combined) against `currentValue` before the per-type extraction loop.

**Action:** Consider using a distinct transaction type (e.g., `TransactionType.Adjustment`) or a non-bankable `fromAccountType` for the admin top-up to avoid polluting participant queries. Low risk since this is a mod-only endpoint.

---

## Copilot Concern: `getBanked` return type

> Copilot flagged: `getBanked` returns `perType` built only from `buzzBankTypes` but cast to `Record<BuzzSpendType, number>`, implying keys like `blue`/`red` exist.

**Status: Not an issue.** The cast at line 184-186 is already `Record<(typeof buzzBankTypes)[number], number>`, which narrows to `'yellow' | 'green'`. The type is correct as written.
