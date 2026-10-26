# Creator Program - Developer Guide

## Overview

The Creator Program lets eligible creators bank their earned Buzz into a monthly compensation pool and receive cash payouts proportional to their contribution. Both Yellow (.com) and Green (.green) Buzz feed into a **single unified pool**.

### Lifecycle (Monthly)

```
Day 1 ──────────────────────────────── Day L-3 ──── Day L
│           Banking Phase              │  Extraction │
│  Users bank yellow/green buzz        │  Users can  │
│  into the pool                       │  withdraw   │
│                                      │  their buzz │
└──────────────────────────────────────┴─────────────┘
                                            ↓
                                   Last day of month:
                                   Distribution job runs
                                   (allocates cash to participants)
                                            ↓
                                   1st-14th of next month:
                                   Pre-payout review runs daily and holds
                                   flagged creators' pending cash
                                            ↓
                                   15th of next month:
                                   Settlement job runs
                                   (cashPending → cashSettled,
                                    skipping held creators)
                                            ↓
                                   User withdraws via Tipalti
```

## Key Concepts

### Buzz Types & Accounts

| Account              | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `yellow`             | Main .com buzz (earned, purchased)       |
| `green`              | Green buzz (.green domain)               |
| `creatorProgramBank` | Unified bank account for all banked buzz |
| `cashPending`        | Cash allocated but not yet settled       |
| `cashSettled`        | Cash ready for withdrawal                |

Both yellow and green buzz bank into the same `creatorProgramBank` account. The source type is preserved in ClickHouse transaction records (`fromAccountType`), so extraction can refund each type correctly.

**Relevant file:** `src/shared/constants/buzz.constants.ts`

- `buzzBankTypes` = `['green', 'yellow']` (order matters for iteration)
- `BuzzSpendType`, `BuzzCreatorProgramType`, `BuzzAccountType` - type definitions

### Month Account

Each month gets a numeric account ID in the format `YYYYMM` (e.g., `202504`). This is used as the `accountId` for the `creatorProgramBank` to separate months.

```typescript
// src/server/services/creator-program.service.ts
export function getMonthAccount(month?: Date) {
  return Number(dayjs(month).format('YYYYMM'));
}
```

### Phases

Determined by `getPhases()` in `src/server/utils/creator-program.utils.ts`:

- **Banking Phase**: Month start to 3 days before month end (UTC)
- **Extraction Phase**: Last 3 days of the month (UTC)

A Redis key `REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES` can swap these for testing.

### Compensation Pool

The pool value is calculated from the previous month's revenue:

```
poolValue = (purchases + redeemable codes) / 1000
          - taxes (CREATOR_POOL_TAXES%)
          * portion (CREATOR_POOL_PORTION%)
```

Fallback: $35,000 if env vars or data are missing.

**Pool size** = total buzz currently banked in `creatorProgramBank` for the month.

## Architecture

### Service Layer

**`src/server/services/creator-program.service.ts`** - Core business logic.

#### Banking

```
bankBuzz(userId, amount, buzzType: 'yellow' | 'green')
```

1. Validates: not banned, has active membership, in banking phase
2. Under a per-user lock, clamps the deposit to the lower of the unified cap (sum of all banked types vs cap) and, from the cutover, the remaining bankable amount. A ClickHouse failure blocks banking but not extraction
3. Creates `TransactionType.Bank` from user's buzz account to `creatorProgramBank`
4. Busts caches, signals pool update

#### Extraction

```
extractBuzz(userId)
```

All-or-nothing across all buzz types:

1. Validates: not banned, in extraction phase
2. Gets banked amounts per type via `getBankedBalance(userId)`
3. Extracts each type back to its original account (green -> green, yellow -> yellow)
4. Calculates fee on combined total, distributes proportionally across types
5. Fee uses `Math.floor` for all but last type (last gets remainder to avoid rounding errors)

#### Getting Banked Amounts

```
getBankedBalance(userId, { fresh? }) → { perType: { yellow: number, green: number }, total: number, cap: UserCapCacheItem }
getBanked(userId)        → { ...getBankedBalance, bankable: BankableAmount | null }
```

- `getBankedBalance` queries `getCounterPartyBuzzTransactions` for each buzz type against `creatorProgramBank`, through a cache. `bankBuzz`, `extractBuzz` and `/api/mod/reset-bank` pass `fresh: true`: the cache can hold a total from before the last deposit while a display read refreshes it
- `getBanked` is for display (the `creatorProgram.getBanked` query). It reads the ClickHouse half of the bankable amount through a 3-minute cache (`REDIS_KEYS.CREATOR_PROGRAM.BANKABLE`) and nets this month's deposits from the bank account. Its `bankable` is `null` before the cutover, without ClickHouse, or when the lookup fails
- The counterparty filter preserves type separation even with a unified bank account
- Cap is unified across all types based on highest membership tier

### Caps

**`src/shared/constants/creator-program.constants.ts`**

| Tier    | Cap            | Peak Earning Multiplier |
| ------- | -------------- | ----------------------- |
| Founder | 100,000        | -                       |
| Bronze  | 100,000        | -                       |
| Silver  | 1,000,000      | 1.25x                   |
| Gold    | No fixed limit | 1.5x                    |

- Minimum cap: 100,000 for all tiers
- Silver/Gold caps scale with peak monthly earnings over a 12-month rolling window. Peak earnings count license fees and paid/early access (`PEAK_EARNING_PREDICATE_SQL`). Until `BANKABLE_CUTOVER` they also count generation compensation (`PRE_CUTOVER_PEAK_EARNING_PREDICATE_SQL`); from it, compensation is excluded for every month in the window. Pool forecasts and `earnedCache` in `buzz.service.ts` still count compensation
- The highest tier across all active subscriptions is used

**Relevant code:** `createUserCapCache()` in the service queries `CustomerSubscription` joined with `Product.metadata.tier`.

### Bankable Amount

**`src/server/services/creator-program-bankable.ts`**

From `BANKABLE_CUTOVER` (2026-11-01 UTC, start of a month) a creator banks up to the lower of the tier cap and their bankable amount:

```
bankable = yellow+green balance at the cutover
         + bankable earnings since the cutover
         - Buzz paid to other users since the cutover
         - banked since the cutover
         + extracted since the cutover, net of the extraction fee
```

- Bankable earnings: `licenseFee`, `donation`, `sell`, `bounty`, App Blocks author fees (matched by the `APP_AUTHOR_FEE_DESCRIPTION` prefix the fee writers also use, under `fee`, `unknown_28` or `appAuthorFee`, the types ClickHouse has stored them as or would after an ingest fix), user-paid `purchase` and `tip`, generation tips, the placement legs paid to creators, and Creator Services escrow releases to the seller (`SERVICE_RELEASE_SQL`: the `release` leg only, never the hold or a refund, and only when it names its buyer in `details.buyerId`) (`BANKABLE_EARNING_PREDICATE_SQL`). Generation tips are their own `compensation` transaction keyed `generation-tip-` since payout date 2026-10-13; earlier tips sit inside compensation, before the cutover, so the snapshot covers them. They are bankable but do not set the peak. Other generation `compensation` is still paid but not bankable, nor is purchased or Blue Buzz.
- The cutover balance is computed from ClickHouse the first time it is needed and stored in the `REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SNAPSHOT` hash, keyed by user id. It is not stored until an hour after the cutover, and not until ClickHouse holds a ledger row dated past that point. That catches an ingest that stalled before then, not pre-cutover rows that arrive later out of order. To recompute a stored snapshot, `HDEL` the user's field from that hash.
- Buzz paid to other users (`paidToUsersSql`) is what the creator paid that became bankable for someone else: user-paid rows, platform-paid sales by `details.purchasedBy`, Creator Services releases by `details.buyerId` (only when the hold, `details.heldAt`, was made from the cutover), and the creator's share of bounty awards by `details.supporterIds` / `supporterAmounts`, counting only charges made from the cutover (`supporterChargedAt`). It comes out of earnings, then out of the cutover balance; the total never goes below zero. Settled days are stored in `REDIS_SYS_KEYS.CREATOR_PROGRAM.BANKABLE_SPENT`, counted once per transaction, so a read scans only the latest days.
- Closed months come from ClickHouse; the current month's deposits come from the bank account via `getBankedBalance`, so a deposit made seconds earlier already counts.

### Extraction Fees

**`src/shared/constants/creator-program.constants.ts`**

| Buzz Amount           | Fee Rate |
| --------------------- | -------- |
| 0 - 100,000           | 0%       |
| 100,001 - 1,000,000   | 5%       |
| 1,000,001 - 5,000,000 | 10%      |
| 5,000,001+            | 15%      |

Tiered: e.g., 200,000 buzz = 0% on first 100k + 5% on next 100k = 5,000 fee.

### Cash & Withdrawals

**Flow:**

1. Distribution job allocates pool value to `cashPending` accounts (last day of month)
2. Pre-payout review (1st-14th of next month) holds flagged creators; the settlement job moves the rest from `cashPending` to `cashSettled` on the 15th. A held creator's cash stays pending until a decision clears it (a withhold is re-decided in the next cycle's review), and a cleared creator is paid on the next 15th. See [Pre-payout review](#pre-payout-review).
3. User calls `withdrawCash()` which creates a Tipalti payment

**Withdrawal fees** (from Tipalti payment method):

- ACH: $2.00 fixed
- PayPal: 5%
- Check: $4.00 fixed

**Minimum withdrawal:** $50 (`MIN_WITHDRAWAL_AMOUNT = 5000` in cents)

**Membership is only a banking gate.** `bankBuzz` requires an active membership; `extractBuzz`, the distribution job and `withdrawCash` do not. A member who lapses mid-month is still paid for what they banked and can withdraw once $50 is ready and payment setup is done.

## Jobs

**`src/server/jobs/creators-program-jobs.ts`**

| Job                                  | Cron          | What it does                                                                                                                                       |
| ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creatorsProgramDistribute`          | `2 23 L * *`  | Allocates pool value to participants as `cashPending`                                                                                              |
| `creatorsProgramInviteTipalti`       | `50 23 L * *` | Creates Tipalti payee for users above $50 threshold                                                                                                |
| `creatorsProgramRollover`            | `0 0 1 * *`   | Flushes all caches for new month                                                                                                                   |
| `creatorsProgramSettleCash`          | `0 0 15 * *`  | Moves `cashPending` -> `cashSettled`, notifies users. Skips creators held by the pre-payout review and also pays creators whose review was cleared |
| `bankingPhaseEndingNotification`     | `5 0 * * *`   | Sends only on the last banking day per `getPhases` (L-3)                                                                                           |
| `extractionPhaseStartedNotification` | `5 0 * * *`   | Sends only on the first extraction day per `getPhases` (L-2)                                                                                       |
| `extractionPhaseEndingNotification`  | `5 0 * * *`   | Sends only on the last day of the month                                                                                                            |

Also: `creatorProgramPrepayoutReview` (`creator-program-prepayout-review`, in `creator-program-prepayout-review.ts`, `0 6 1-14 * *`) reviews last month's pending batch; see [Pre-payout review](#pre-payout-review).

The three stage notifications run daily and gate on `getStageNotificationDays`, rather than encoding the day in an `L-n` cron: after `bankingPhaseEndingNotification` moved from `L-4` to `L-3`, the external scheduler still fired it on the `L-4` day. They are registered as `creator-program-notify-<stage>` so the scheduler picks them up as new jobs.

### Distribution Logic

1. Get unified compensation pool (value + size)
2. Get all participants from `creatorProgramBank` for the month
3. For each participant: `share = floor(poolValue * (userBanked / totalBanked) * 100)`
4. Cap per-buzz value at `CAPPED_BUZZ_VALUE` ($0.001/buzz)
5. Create `cashPending` transactions
6. Advance month counter in `dbKV`

### Pre-payout review

`creator-program-prepayout-review` (`src/server/jobs/creator-program-prepayout-review.ts`, logic in `src/server/services/creator-program-prepayout-review/`) runs daily on the 1st-14th. It reads the batch `creatorsProgramDistribute` credited to `cashPending` for last month, evaluates each creator against ClickHouse ledger data, and writes a hold row to `CreatorProgramPayoutReview` for each creator it flags. Re-runs refresh the evidence and leave the decision alone, except that a signal the row had not seen when it was cleared reopens it as `open` and holds it again (recorded in `decisions` as `reopened`, by `prepayout-review`); a run from the 15th on is skipped because that batch has settled. Each run is recorded in `CreatorProgramPayoutReviewRun`; settlement treats the period as reviewed only if a finished run with no error exists.

- **Hold.** `creatorsProgramSettleCash` calls `getSettlementHolds(period)` and leaves out any creator with an undecided review (`open` or `escalated`, any period) or whose latest review is `withheld`. Their `cashPending` is untouched.
- **Withheld is per cycle.** A withhold means not paid this cycle, never forfeited. The cash stays pending, and the next run files a new review for the creator (signal `withheld-carried`) whether or not they were credited again, so they are decided afresh each month. A later `cleared` review pays them.
- **Decisions.** `POST /api/admin/creator-program-payout-review` (moderator session; body `id`, `userId`, `period`, `action` of `escalate` | `clear` | `withhold`, `version`, optional `note` and `askRef`). Every write to a row bumps `version`; a 409 means the row changed since it was read or the action is not allowed from its status (clear: open, escalated or withheld; escalate: open or cleared; withhold: open, escalated or cleared); a mismatched id, user or period is a 404. The decider recorded is the authenticated moderator, and each decision is appended to the row's `decisions` history. The route moves no money: a cleared creator (not banned, not program-banned) is added to the next settlement's account set.
- **Limits.** Every threshold, including the payout-jump percentile and how many earlier payouts it compares against, is read from sysRedis `creator-program:prepayout-limits` (JSON), ops-owned with no default in code; ask an infra owner. Until that key is set and valid, each run records a failed run and flags nobody. The review also uses the daily `creator-program-counterparty-review` job's minimum (`readMinimum`), which defaults to `DEFAULT_COUNTERPARTY_REVIEW_MIN` when nothing valid is stored.
- **Fails open.** A missing or invalid key, no ClickHouse or an empty batch records a failed run and holds nobody. An error mid-run records a failed run but keeps the holds already filed. Either way the batch counts as unreviewed: settlement still pays everyone not held and logs `creator-program-prepayout-review-missing`. Missing tables (code deployed before the migration) behave the same. Any other error reading holds stops settlement before it pays anyone.
- **Deploy order.** Apply `20261109120000_creator_program_payout_review` by hand before the deploy, then set the sysRedis key before the 1st.
- **Reporting.** New and reopened holds are posted to the moderator app as an abuse report (detector `creator-program-prepayout`).

## Caching

### Redis Keys (`REDIS_KEYS.CREATOR_PROGRAM`)

| Key                 | Content                                                                                                                    | TTL               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `CAPS`              | User cap data (tier, peak earnings, cap amount). A cap cached before `BANKABLE_CUTOVER` is refilled on first read after it | 1 day             |
| `BANKED:{userId}`   | Per-type banked amounts for user                                                                                           | 1 day             |
| `BANKABLE:{userId}` | Bankable ledger for display (cutover balance, earned, consumed)                                                            | 3 min             |
| `CASH`              | User cash balance (pending, ready, withdrawn)                                                                              | 1 day             |
| `POOL_VALUE`        | Monthly pool dollar value                                                                                                  | 1 day             |
| `POOL_SIZE`         | Current total banked buzz                                                                                                  | Not cached (live) |
| `POOL_FORECAST`     | Forecasted pool size                                                                                                       | 1 day             |
| `PREV_MONTH_STATS`  | Previous month statistics                                                                                                  | 1 month           |

**Cache busting:** After bank/extract/withdraw operations, relevant caches are busted and signals sent for realtime UI updates.

### Legacy Cache Cleanup

The `bustCompensationPoolCache()` function also clears old per-type cache keys (`:yellow`, `:green` suffixes) from before the pool unification.

## Data Storage

### ClickHouse (`buzzTransactions` table)

Used for:

- Peak earnings calculation (license fees, early access)
- Bankable amount (cutover balance, bankable earnings, banked and extracted since the cutover)
- Pool value calculation (purchases, redeemable codes)
- Pool forecast (projected earnings)
- Pool participants (bank/extract transactions)

### PostgreSQL

| Table                              | Purpose                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `User`                             | `onboarding` bitwise flags for program membership/bans                                                                |
| `CustomerSubscription` + `Product` | Membership tier for cap calculation                                                                                   |
| `CashWithdrawal`                   | Withdrawal records (status, amount, fee, Tipalti metadata)                                                            |
| `UserPaymentConfiguration`         | Tipalti account setup, payment method, status                                                                         |
| `CreatorProgramPayoutReview`       | One row per (`period`, `userId`) the pre-payout review flagged: status, `hold`, evidence, `version`, decision history |
| `CreatorProgramPayoutReviewRun`    | One row per review run: counts, `finishedAt`, `error`; settlement reads it to know whether the period was reviewed    |

## Realtime Updates

**Signal topic:** `SignalTopic.CreatorProgram` (`'creators-program'`)

| Signal                   | When                      | Data                     |
| ------------------------ | ------------------------- | ------------------------ |
| `CompensationPoolUpdate` | After bank/extract        | Full pool object         |
| `CashInvalidator`        | After withdraw/settlement | Empty (triggers refetch) |

Frontend hooks in `src/components/Buzz/CreatorProgramV2/CreatorProgram.util.ts` listen via `useCreatorPoolListener()`.

## Access Control

### Joining Requirements

1. **Creator Score >= 40,000** (`MIN_CREATOR_SCORE`) - calculated from model/article/image/user scores
2. **Active membership** (Bronze, Silver, or Gold - NOT Founder or Free)
3. **Not banned** (`OnboardingSteps.BannedCreatorProgram` flag)

### Onboarding Flags

Bitwise flags on `User.onboarding`:

| Flag                   | Value | Meaning                                 |
| ---------------------- | ----- | --------------------------------------- |
| `CreatorProgram`       | 16    | User has joined the creator program     |
| `BannedCreatorProgram` | 32    | User is banned from the creator program |

## Tipalti Integration

**`src/server/http/tipalti/tipalti.caller.ts`** - HTTP client for Tipalti API.

### Flow

1. User reaches $50 in `cashSettled` -> `creatorsProgramInviteTipalti` job creates payee
2. User completes Tipalti onboarding (via email link or dashboard URL)
3. Tipalti webhook updates `UserPaymentConfiguration` with account status and payment method
4. User calls `withdrawCash()` -> creates payment batch via Tipalti API
5. Tipalti processes payment -> webhook updates withdrawal status

### Key Functions

- `createTipaltiPayee()` - Creates payee, sends invite email
- `payToTipaltiAccount()` - Submits payment batch (amount in dollars, not cents!)
- `getTipaltiDashboardUrl()` - Signed URL for user's payment dashboard

## Frontend

### Components

| Component               | File                                                         | Purpose                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CreatorProgramV2`      | `src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx`  | Main dashboard                                                                                                                                                     |
| `BankBuzzCard`          | Same file                                                    | Buzz type selector + amount input for banking                                                                                                                      |
| `ExtractBuzzCard`       | Same file                                                    | All-or-nothing extraction button                                                                                                                                   |
| `CompensationPoolCard`  | Same file                                                    | Unified pool value and size                                                                                                                                        |
| `EstimatedEarningsCard` | Same file                                                    | Per-type banked breakdown + value estimate                                                                                                                         |
| `WithdrawCashCard`      | Same file                                                    | Cash withdrawal interface                                                                                                                                          |
| `MembershipLapsedCard`  | Same file                                                    | Notice for an onboarded member whose membership lapsed: banking is closed, banked Buzz still pays out at month end, withdrawing needs $50 ready plus payment setup |
| `getPaidCards`          | `src/components/Buzz/CreatorProgramV2/getPaidCards.ts`       | Which Bank / Extract / Estimated Earnings / Withdraw cards render for a phase and lapse state; only Bank is hidden when lapsed                                     |
| `BankableBuzzMeter`     | `src/components/Buzz/CreatorProgramV2/BankableBuzzMeter.tsx` | From the cutover, splits the yellow + green balance into bankable this month, over the cap, and not bankable (`getBankableBreakdown`)                              |

### Hooks (`CreatorProgram.util.ts`)

| Hook                        | Returns                                  |
| --------------------------- | ---------------------------------------- |
| `useCompensationPool()`     | Unified pool data                        |
| `useBankedBuzz()`           | `{ perType, total, cap, bankable }`      |
| `useCreatorProgramPhase()`  | Current phase ('bank' or 'extraction')   |
| `useCreatorProgramMutate()` | Bank, extract, withdraw mutations        |
| `useCreatorPoolListener()`  | Subscribes to realtime pool/cash signals |

### Pages

- `/creator-program` - Landing page with how-it-works, FAQ, stats (`src/pages/creator-program/index.tsx`)
- `/user/buzz-dashboard` - Main dashboard with `CreatorProgramV2` component (`src/pages/user/buzz-dashboard.tsx`)

## Testing

Test files: `src/server/services/__tests__/creator-program.service.test.ts`, `src/server/services/__tests__/creator-program-bankable.test.ts`, `src/shared/utils/__tests__/creator-program.utils.test.ts`

Pre-payout review: `src/server/services/creator-program-prepayout-review/__tests__/`, `src/server/jobs/__tests__/creator-program-settlement-hold.test.ts`.

Covers: `getCreatorRequirements`, `joinCreatorsProgram`, `getBanked`/`getBankedBalance`, `bankBuzz`, `extractBuzz`, `getCompensationPool`, `withdrawCash`, unified pool invariants, the bankable amount.

Run tests:

```bash
pnpm exec vitest run --project 'unit*' src/server/services/__tests__/creator-program.service.test.ts src/server/services/__tests__/creator-program-bankable.test.ts src/shared/utils/__tests__/creator-program.utils.test.ts
```

Shared utility tests: `src/shared/utils/__tests__/creator-program.utils.test.ts` (cap calculations).

## Environment Variables

| Variable                        | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `CREATOR_POOL_TAXES`            | Tax percentage to deduct from gross revenue      |
| `CREATOR_POOL_PORTION`          | Percentage of post-tax revenue allocated to pool |
| `CREATOR_POOL_FORECAST_PORTION` | Percentage for forecasted pool size              |
| `TIPALTI_API_URL`               | Tipalti API base URL                             |
| `TIPALTI_*`                     | Various Tipalti auth credentials                 |
