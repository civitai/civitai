# Plan: Unify Creator Program Compensation Pool + Enable on .com

## Context
The creator program currently maintains **separate compensation pools** for yellow (.com) and green (.green) buzz. Green is also gated behind a "Coming Soon" placeholder. The task is to:
1. Remove the "Coming Soon" gate - enable creator program on green
2. Merge into a **single compensation pool** where users can bank either yellow or green buzz
3. Extraction refunds buzz to the original type it was banked from

## Approach

### Single bank account, unified pool
- **Collapse to single `creatorProgramBank`** account for both yellow and green buzz. ClickHouse transactions always record the source account type (`fromAccountType: yellow/green`), so extraction can still refund to the correct type. `getBanked(userId, 'yellow')` / `getBanked(userId, 'green')` will still work because `getCounterPartyBuzzTransactions` filters on the counterparty (user) account type.
- `getBankAccountType()` always returns `'creatorProgramBank'` regardless of input buzz type
- Pool value/size/forecast calculations aggregate across both yellow and green
- UI lets users choose which buzz type to bank; extraction is per-type

---

## Changes

### 1. Service: `src/server/services/creator-program.service.ts`

**`getBankAccountType(buzzType)`** (~line 86)
- Always return `'creatorProgramBank'` (ignore buzzType)

**`createUserCapCache(buzzType)`** (~line 90)
- Collapse to a single cache (no per-type cache). The ClickHouse query for peak earnings should aggregate across both yellow and green (`toAccountType IN ('yellow', 'green')`)

**`getUserCapCache()`** (~line 164)
- Single cache instance instead of per-buzzType map

**`getBanked(userId)`** (~line 181)
- Remove buzzType param. Return a combined object with per-type banked totals and a single unified cap based on the user's highest membership tier (e.g. `{ yellow: { total }, green: { total }, total, cap }`)
- Single cache key per user instead of per-type

**`getPoolValue(month)`** (~line 281)
- Remove `buzzType` param
- ClickHouse query: `toAccountType IN ('yellow', 'green')` instead of single type

**`getPoolSize(month)`** (~line 309)
- Remove `buzzType` param
- Query single `creatorProgramBank` account (now holds both types)

**`getPoolForecast(month)`** (~line 323)
- Remove `buzzType` param
- Aggregate across both yellow and green

**`getCompensationPool({ month })`** (~line 344)
- Remove `buzzType` from signature - always returns unified pool
- Single set of cache keys (no per-type suffixes)

**`bustCompensationPoolCache()`** (~line 386)
- Simplify to single set of cache keys

**`bankBuzz()`** (~line 400)
- `getBankAccountType(buzzType)` now returns `creatorProgramBank` for both types - no other change needed
- Update pool size cache bust to unified key

**`extractBuzz(userId)`** (~line 463)
- Remove buzzType param. Fetch unified `getBanked(userId)`, then extract each type that has a positive balance back to its original type. Single extraction = all-or-nothing across all banked types.
- Update pool size cache bust to unified key

**`getPrevMonthStats()`** (~line 1025)
- Remove `buzzType` param
- Combine participants from both types via `getPoolParticipants`/`getPoolParticipantsV2`

**`getPoolParticipants()`** (~line 830) and **`getPoolParticipantsV2()`** (~line 880)
- Remove `buzzType`/`accountType` param
- Query single `creatorProgramBank` account

### 2. Schema: `src/server/schema/creator-program.schema.ts`
- `compensationPoolInputSchema` - remove `buzzType` field (pool is unified)
- `bankBuzzSchema` - keep `accountType` (user still chooses which buzz to bank)

### 3. Router: `src/server/routers/creator-program.router.ts`
- `getCompensationPool` - input no longer has buzzType
- `getPrevMonthStats` - remove buzzType input (unified)
- `getBanked` - remove buzzType input. Returns single object with all banked types
- `extractBuzz` - remove buzzType input (all-or-nothing across all types)

### 4. Distribution Job: `src/server/jobs/creators-program-jobs.ts`
- `creatorsProgramDistribute` (~line 37): Remove `buzzBankTypes` loop. Single call to `getCompensationPool` + `getPoolParticipantsV2` against unified pool
- `creatorsProgramSettleCash` (~line 186): Single call to `getPoolParticipantsV2` (no type param)
- `creatorsProgramInviteTipalti` (~line 118): Single call to `getPoolParticipantsV2`
- `creatorsProgramRollover` (~line 173): Single cap cache flush instead of per-type loop

### 5. UI - Remove "Coming Soon": `src/pages/creator-program/index.tsx`
- Remove `isGreenTemporarilyDisabled` check and entire "Coming Soon" block (~lines 415-461)
- Update FAQ - remove Q about separate pools for .green and .com (~line 592)
- Update FAQ "What types of Buzz can be Banked?" to reflect unified pool

### 6. UI - Remove green alert: `src/pages/user/buzz-dashboard.tsx`
- Remove the green "Temporarily Disabled" alert (~lines 233-241)
- Show `CreatorProgramV2` for BOTH yellow and green (not just yellow) (~line 242)

### 7. UI - CreatorProgramV2 Component: `src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx`
- **Main component** (~line 108): Pool is unified, no buzzType needed for pool/phase queries. Still need to track domain buzz type for banking default selection.
- **BankBuzzCard** (~line 387): Add buzz type selector (dropdown/tabs) so user can pick yellow OR green to bank from. Show balances for both. The `bankBuzz` call already accepts `accountType`.
- **ExtractBuzzCard** (~line 1062): Single extract button. Extraction is all-or-nothing -- show combined banked total, one button that extracts everything. Backend `extractBuzz` calls extraction for each type that has a positive balance (yellow and/or green), refunding each to the correct type.
- **CompensationPoolCard** (~line 336): Remove buzzType prop - shows unified pool
- **EstimatedEarningsCard**: Remove buzzType dependency for pool data

### 8. UI - Util hooks: `src/components/Buzz/CreatorProgramV2/CreatorProgram.util.ts`
- `useCompensationPool()` - remove buzzType param (unified)
- `useBankedBuzz()` - remove buzzType param, returns unified object with all types
- `useCreatorProgramPhase()` - remove buzzType (phases are unified)
- `useCreatorPoolListener()` - simplify signal handling (no buzzType)

---

## Files to modify
1. `src/server/services/creator-program.service.ts` - single bank account, unify pool calculations
2. `src/server/schema/creator-program.schema.ts` - remove buzzType from pool schema
3. `src/server/routers/creator-program.router.ts` - update endpoints
4. `src/server/jobs/creators-program-jobs.ts` - unify distribution
5. `src/pages/creator-program/index.tsx` - remove Coming Soon + update FAQ
6. `src/pages/user/buzz-dashboard.tsx` - remove green gate, show for both
7. `src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx` - unified pool UI + buzz type selector for banking
8. `src/components/Buzz/CreatorProgramV2/CreatorProgram.util.ts` - update hooks
9. `src/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals.tsx` - minor: remove buzzType from pool modal if needed

## Verification
1. Typecheck: `pnpm run typecheck`
2. Lint: `pnpm run lint`
3. Manual: On .green, creator program should show (no "Coming Soon")
4. Manual: BankBuzzCard should offer choice of yellow or green buzz to bank
5. Manual: Compensation pool should show unified value (not per-type)
6. Manual: Extraction should refund correct buzz type (yellow back to yellow, green back to green)
