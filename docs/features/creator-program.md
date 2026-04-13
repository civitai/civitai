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
                                   15th of next month:
                                   Settlement job runs
                                   (cashPending → cashSettled)
                                            ↓
                                   User withdraws via Tipalti
```

## Key Concepts

### Buzz Types & Accounts

| Account | Purpose |
|---------|---------|
| `yellow` | Main .com buzz (earned, purchased) |
| `green` | Green buzz (.green domain) |
| `creatorProgramBank` | Unified bank account for all banked buzz |
| `cashPending` | Cash allocated but not yet settled |
| `cashSettled` | Cash ready for withdrawal |

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
2. Checks unified cap (sum of all banked types vs cap)
3. Creates `TransactionType.Bank` from user's buzz account to `creatorProgramBank`
4. Busts caches, signals pool update

#### Extraction

```
extractBuzz(userId)
```

All-or-nothing across all buzz types:

1. Validates: not banned, in extraction phase
2. Gets banked amounts per type via `getBanked(userId)`
3. Extracts each type back to its original account (green -> green, yellow -> yellow)
4. Calculates fee on combined total, distributes proportionally across types
5. Fee uses `Math.floor` for all but last type (last gets remainder to avoid rounding errors)

#### Getting Banked Amounts

```
getBanked(userId) → { perType: { yellow: number, green: number }, total: number, cap: UserCapCacheItem }
```

- Queries `getCounterPartyBuzzTransactions` for each buzz type against `creatorProgramBank`
- The counterparty filter preserves type separation even with a unified bank account
- Cap is unified across all types based on highest membership tier

### Caps

**`src/shared/constants/creator-program.constants.ts`**

| Tier | Cap | Peak Earning Multiplier |
|------|-----|------------------------|
| Founder | 100,000 | - |
| Bronze | 100,000 | - |
| Silver | 1,000,000 | 1.25x |
| Gold | No fixed limit | 1.5x |

- Minimum cap: 100,000 for all tiers
- Silver/Gold caps scale with peak monthly earnings over a 12-month rolling window
- The highest tier across all active subscriptions is used

**Relevant code:** `createUserCapCache()` in the service queries `CustomerSubscription` joined with `Product.metadata.tier`.

### Extraction Fees

**`src/shared/constants/creator-program.constants.ts`**

| Buzz Amount | Fee Rate |
|-------------|----------|
| 0 - 100,000 | 0% |
| 100,001 - 1,000,000 | 5% |
| 1,000,001 - 5,000,000 | 10% |
| 5,000,001+ | 15% |

Tiered: e.g., 200,000 buzz = 0% on first 100k + 5% on next 100k = 5,000 fee.

### Cash & Withdrawals

**Flow:**
1. Distribution job allocates pool value to `cashPending` accounts (last day of month)
2. Settlement job moves `cashPending` to `cashSettled` (15th of next month)
3. User calls `withdrawCash()` which creates a Tipalti payment

**Withdrawal fees** (from Tipalti payment method):
- ACH: $2.00 fixed
- PayPal: 5%
- Check: $4.00 fixed

**Minimum withdrawal:** $50 (`MIN_WITHDRAWAL_AMOUNT = 5000` in cents)

## Jobs

**`src/server/jobs/creators-program-jobs.ts`**

| Job | Cron | What it does |
|-----|------|-------------|
| `creatorsProgramDistribute` | `2 23 L * *` | Allocates pool value to participants as `cashPending` |
| `creatorsProgramInviteTipalti` | `50 23 L * *` | Creates Tipalti payee for users above $50 threshold |
| `creatorsProgramRollover` | `0 0 1 * *` | Flushes all caches for new month |
| `creatorsProgramSettleCash` | `0 0 15 * *` | Moves `cashPending` -> `cashSettled`, notifies users |
| `bankingPhaseEndingNotification` | `0 0 L-4 * *` | Notifies users banking phase is ending |
| `extractionPhaseStartedNotification` | `0 0 L-3 * *` | Notifies extraction phase started |
| `extractionPhaseEndingNotification` | `0 0 L * *` | Notifies extraction phase ending |

### Distribution Logic

1. Get unified compensation pool (value + size)
2. Get all participants from `creatorProgramBank` for the month
3. For each participant: `share = floor(poolValue * (userBanked / totalBanked) * 100)`
4. Cap per-buzz value at `CAPPED_BUZZ_VALUE` ($0.001/buzz)
5. Create `cashPending` transactions
6. Advance month counter in `dbKV`

## Caching

### Redis Keys (`REDIS_KEYS.CREATOR_PROGRAM`)

| Key | Content | TTL |
|-----|---------|-----|
| `CAPS` | User cap data (tier, peak earnings, cap amount) | 1 day |
| `BANKED:{userId}` | Per-type banked amounts for user | 1 day |
| `CASH` | User cash balance (pending, ready, withdrawn) | 1 day |
| `POOL_VALUE` | Monthly pool dollar value | 1 day |
| `POOL_SIZE` | Current total banked buzz | Not cached (live) |
| `POOL_FORECAST` | Forecasted pool size | 1 day |
| `PREV_MONTH_STATS` | Previous month statistics | 1 month |

**Cache busting:** After bank/extract/withdraw operations, relevant caches are busted and signals sent for realtime UI updates.

### Legacy Cache Cleanup

The `bustCompensationPoolCache()` function also clears old per-type cache keys (`:yellow`, `:green` suffixes) from before the pool unification.

## Data Storage

### ClickHouse (`buzzTransactions` table)

Used for:
- Peak earnings calculation (compensation, tips, early access)
- Pool value calculation (purchases, redeemable codes)
- Pool forecast (projected earnings)
- Pool participants (bank/extract transactions)

### PostgreSQL

| Table | Purpose |
|-------|---------|
| `User` | `onboarding` bitwise flags for program membership/bans |
| `CustomerSubscription` + `Product` | Membership tier for cap calculation |
| `CashWithdrawal` | Withdrawal records (status, amount, fee, Tipalti metadata) |
| `UserPaymentConfiguration` | Tipalti account setup, payment method, status |

## Realtime Updates

**Signal topic:** `SignalTopic.CreatorProgram` (`'creators-program'`)

| Signal | When | Data |
|--------|------|------|
| `CompensationPoolUpdate` | After bank/extract | Full pool object |
| `CashInvalidator` | After withdraw/settlement | Empty (triggers refetch) |

Frontend hooks in `src/components/Buzz/CreatorProgramV2/CreatorProgram.util.ts` listen via `useCreatorPoolListener()`.

## Access Control

### Joining Requirements

1. **Creator Score >= 40,000** (`MIN_CREATOR_SCORE`) - calculated from model/article/image/user scores
2. **Active membership** (Bronze, Silver, or Gold - NOT Founder or Free)
3. **Not banned** (`OnboardingSteps.BannedCreatorProgram` flag)

### Onboarding Flags

Bitwise flags on `User.onboarding`:

| Flag | Value | Meaning |
|------|-------|---------|
| `CreatorProgram` | 16 | User has joined the creator program |
| `BannedCreatorProgram` | 32 | User is banned from the creator program |

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

| Component | File | Purpose |
|-----------|------|---------|
| `CreatorProgramV2` | `src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx` | Main dashboard |
| `BankBuzzCard` | Same file | Buzz type selector + amount input for banking |
| `ExtractBuzzCard` | Same file | All-or-nothing extraction button |
| `CompensationPoolCard` | Same file | Unified pool value and size |
| `EstimatedEarningsCard` | Same file | Per-type banked breakdown + value estimate |
| `WithdrawCashCard` | Same file | Cash withdrawal interface |

### Hooks (`CreatorProgram.util.ts`)

| Hook | Returns |
|------|---------|
| `useCompensationPool()` | Unified pool data |
| `useBankedBuzz()` | `{ perType, total, cap }` |
| `useCreatorProgramPhase()` | Current phase ('bank' or 'extraction') |
| `useCreatorProgramMutate()` | Bank, extract, withdraw mutations |
| `useCreatorPoolListener()` | Subscribes to realtime pool/cash signals |

### Pages

- `/creator-program` - Landing page with how-it-works, FAQ, stats (`src/pages/creator-program/index.tsx`)
- `/user/buzz-dashboard` - Main dashboard with `CreatorProgramV2` component (`src/pages/user/buzz-dashboard.tsx`)

## Testing

Test file: `src/server/services/__tests__/creator-program.service.test.ts`

Covers: `getCreatorRequirements`, `joinCreatorsProgram`, `getBanked`, `bankBuzz`, `extractBuzz`, `getCompensationPool`, `withdrawCash`, unified pool invariants.

Run tests:
```bash
pnpm run test:unit -- src/server/services/__tests__/creator-program.service.test.ts
```

Shared utility tests: `src/shared/utils/__tests__/creator-program.utils.test.ts` (cap calculations).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CREATOR_POOL_TAXES` | Tax percentage to deduct from gross revenue |
| `CREATOR_POOL_PORTION` | Percentage of post-tax revenue allocated to pool |
| `CREATOR_POOL_FORECAST_PORTION` | Percentage for forecasted pool size |
| `TIPALTI_API_URL` | Tipalti API base URL |
| `TIPALTI_*` | Various Tipalti auth credentials |
