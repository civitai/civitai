# Buzz Account System

Virtual currency system for transactions, rewards, and payments.

## Overview

Buzz is Civitai's virtual currency used for:
- Generation credits
- Tipping creators
- Entry fees for competitions
- Prize pools and rewards
- Premium features

## Key Files

| File | Purpose |
|------|---------|
| `packages/civitai-buzz/src/account-types.ts` | The account-type model + friendly↔API name map |
| `src/shared/constants/buzz.constants.ts` | `TransactionType`, per-type config, derived type lists |
| `src/server/schema/buzz.schema.ts` | Authoritative zod input contracts |
| `src/server/services/buzz.service.ts` | Transaction handling (thin wrappers over `@civitai/buzz`) |
| `src/server/services/bounty.service.ts` | Prize pool pattern reference |

## Buzz Types

The account-type model lives in `@civitai/buzz` and is re-exported through
`buzz.constants.ts`. The three user-facing spend types:

```typescript
yellow: 'User'       // NSFW-enabled, bankable, purchasable
green: 'Green'       // Bankable, purchasable
blue: 'Generation'   // Non-bankable (generation credits)
```

There are **nine** account types in total, not three. Beyond the above: `red` (a spend type
currently flagged `disabled`, so it's excluded from `buzzSpendTypes`), `creatorProgramBank`,
`creatorProgramBankGreen`, `cashPending`, `cashSettled` and `club`. Derive lists from
`buzzSpendTypes` / `buzzBankTypes` / `buzzPurchaseTypes` rather than hardcoding colors.

## Transaction Types

**Do not hardcode these numbers.** `TransactionType` in `src/shared/constants/buzz.constants.ts`
is the only source of truth — always import the enum and reference members by name:

```typescript
import { TransactionType } from '~/shared/constants/buzz.constants';
```

The values are not in any intuitive order (`Tip` is `0`, not `1`), the enum has grown over time,
and a wrong literal books a transaction as a *different real type* with no type error and no
runtime failure. An earlier version of this doc restated the values and got two of six wrong.

## Usage

### Basic Transaction

```typescript
import { createBuzzTransaction } from '~/server/services/buzz.service';

await createBuzzTransaction({
  fromAccountId: userId,
  toAccountId: recipientId,
  amount: 100,
  type: TransactionType.Tip,
});
```

### Multi-Account Transaction (spending across buzz colors)

`createMultiAccountBuzzTransaction` debits **one user** across several of their buzz colors. It is
not the prize-pool API — `fromAccountId` is `min(1)` in the schema, so it cannot pay *out of* the
central bank.

`externalTransactionIdPrefix` is required, and it is also the refund key:
`refundMultiAccountTransaction` takes only that prefix, so a transaction created without a
meaningful one cannot be refunded through the supported path.

```typescript
import { createMultiAccountBuzzTransaction } from '~/server/services/buzz.service';

await createMultiAccountBuzzTransaction({
  fromAccountId: ctx.user.id,
  fromAccountTypes: getAllowedAccountTypes(ctx.features),
  toAccountId: recipientUserId,
  amount: price,
  type: TransactionType.Purchase,
  description: `Early access: ${name}`,
  details: { comicChapterId: chapter.id },
  externalTransactionIdPrefix: `comic-ea-${chapter.id}-${ctx.user.id}`,
});
```

### Prize pools (paying out of the central bank)

Payouts from account `0` use the **single**-account API instead:

```typescript
import { createBuzzTransactionMany } from '~/server/services/buzz.service';

await createBuzzTransactionMany(
  winners.map(({ userId }) => ({
    type: TransactionType.Reward,
    fromAccountId: 0, // central bank
    toAccountId: userId,
    toAccountType: 'blue',
    amount: prizeAmount,
    description: `Challenge Prize: ${challenge.title}`,
    externalTransactionId: `challenge-prize-${challengeId}-${userId}`,
  }))
);
```

Fee collection runs the same way in reverse, with `toAccountId: 0`. See `challenge.service.ts` for
both directions.

## Central Bank (Account 0)

Account ID `0` is the central bank used for:
- Holding prize pools
- System-level transactions
- Fee collection

## Balance Checking

```typescript
import { getUserBuzzAccounts } from '~/server/services/buzz.service';

// One entry per spend type
const accounts = await getUserBuzzAccounts({ userId });
```

`getUserBuzzAccount` (singular) returns a **one-element array defaulted to yellow** unless you pass
`accountTypes` — it is not the per-type balance call despite the name.
