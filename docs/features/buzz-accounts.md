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
| `src/shared/constants/buzz.constants.ts` | Account types and transaction types |
| `src/server/services/buzz.service.ts` | Transaction handling |
| `src/server/services/bounty.service.ts` | Prize pool pattern reference |

## Buzz Types

There are different "colors" of buzz with different properties:

```typescript
// Spend types (user-facing)
yellow: 'User'       // NSFW-enabled, bankable, purchasable
green: 'Green'       // Bankable, purchasable
blue: 'Generation'   // Non-bankable (generation credits)
```

## Transaction Types

```typescript
enum TransactionType {
  Tip = 1,           // Tipping creators
  Reward = 5,        // Prize distribution
  Purchase = 6,      // Buying buzz
  Bounty = 8,        // Bounty/competition fees
  BountyEntry = 9,   // Entry fee collection
  Fee = 10,          // Generic fees
  // ... others
}
```

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

### Multi-Account Transaction (Prize Pools)

For collecting fees into a central pool and distributing prizes:

```typescript
import { createMultiAccountBuzzTransaction } from '~/server/services/buzz.service';

// Collect entry fee into central bank (account 0)
await createMultiAccountBuzzTransaction({
  fromAccountId: userId,
  fromAccountTypes: ['yellow'],  // Deduct from yellow buzz
  toAccountId: 0,                // Central bank holds pool
  amount: entryFee,
  type: TransactionType.Fee,
  details: { entityId: contestId, entityType: 'Contest' },
});

// Distribute prize from central bank
await createMultiAccountBuzzTransaction({
  fromAccountId: 0,              // From central bank
  fromAccountTypes: ['yellow'],
  toAccountId: winnerId,
  amount: prizeAmount,
  type: TransactionType.Reward,
  details: { entityId: contestId, entityType: 'Contest' },
});
```

## Central Bank (Account 0)

Account ID `0` is the central bank used for:
- Holding prize pools
- System-level transactions
- Fee collection

## Balance Checking

```typescript
import { getUserBuzzAccount } from '~/server/services/buzz.service';

const account = await getUserBuzzAccount({ accountId: userId });
// Returns balance for each buzz type
```
