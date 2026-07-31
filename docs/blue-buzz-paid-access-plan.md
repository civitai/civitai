# Blue Buzz for early / paid access

Status: proposal, nothing implemented.
Ask: let a creator opt in to **accepting Blue Buzz** for early/paid access purchases.

## What this is and isn't

@dev: "Blue and yellow prices would be the same number. Really, we're asking if the creator is open to
receiving generation credit (blue buzz). They should still be able to accept green/yellow as they normally
would."

So this is **one price, an extra accepted currency** — not dual pricing, and not a replacement. Green/yellow
behaviour is untouched; blue is additive and opt-in.

The trade a creator is accepting: **Blue Buzz is not bankable.** `buzzTypeConfig` gives green and yellow
`bankable: true`; blue has neither `bankable` nor `purchasable`. It is earned/granted credit — rewards mint
blue by default (`base.reward.ts:110`). A creator opting in is choosing to be paid in generation credits they
cannot withdraw. **The UI has to say that plainly** or it generates support tickets.

## The one line that matters

`buzz.service.ts:1106`:

```ts
input.toAccountType = input.toAccountType ?? 'yellow'; // Default to bank if not provided
```

The destination is yellow **regardless of what the buyer spent**. Wire blue into paid access without
changing this and you have built a free-credit-to-cash conversion: farm blue from rewards, spend it on a
cooperating creator's version, creator withdraws yellow. Self-purchase is blocked, two accounts defeat that.

**So: when the buyer pays blue, the creator receives blue.** `toAccountType` is settable per call — the `??`
is only a default — so this is one argument, not a service change.

## What already works

| Piece                      | State                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Charging a chosen currency | `earlyAccessPurchase` already passes `fromAccountTypes: [buzzType]`                                                                                          |
| Per-call destination       | `createMultiAccountBuzzTransaction` accepts `toAccountType`                                                                                                  |
| Client currency UI         | `BuzzTransactionButton` takes `accountTypes` and renders a distribution                                                                                      |
| Creator Program exclusion  | Earnings queries filter `toAccountType IN ('yellow', 'green')` — blue is **already** excluded (`creator-program.service.ts:74`, used at 120/317/354/889/894) |

The block is a single explicit guard at `model-version.service.ts:1908`:

```ts
if (buzzType === 'blue')
  throw throwBadRequestError('You cannot use Blue Buzz for early access purchases.');
```

Today it is belt-and-braces — the controller passes `getAllowedAccountTypes(ctx.features)[0]`, which resolves
to green or yellow by domain, so blue is never offered in the first place.

## Decision needed: single currency, or drain blue then top up?

This is the one open design question, and the client is already built for the harder option.

**Option A — single currency, buyer picks (recommended for v1).**
`fromAccountTypes` stays a one-element array. Choose blue, pay entirely in blue, or the transaction fails on
insufficient funds. One source, one destination, one transaction. Matches "same price, different currency"
exactly.

**Option B — drain blue, top up from yellow.**
`BuzzTransactionButton` already computes a spend distribution across multiple types, so the UI supports it.
But the payment then has two source colours and `toAccountType` is singular — the creator would have to be
paid in two transactions, or the service needs a split payout. **And getting this wrong is the loophole
above**: `fromAccountTypes: ['blue','yellow']` with the default destination silently converts blue to yellow.

Recommend A, and note that **`getAllowedAccountTypes` must not be used on the charge path**:
`getAllowedAccountTypes(features, ['blue'])` returns `['blue', 'yellow']`, and spend drains in array order —
so it would spend blue first for everyone, with no choice involved. It remains the right helper for deciding
what the client may _offer_.

## Storage

**`PaidAccess.terms`**, as `acceptsBlueBuzz?: boolean` alongside `download` / `generation`.

Chosen for read cost: `terms` is already loaded by `earlyAccessPurchase` and already reaches the client via
`useModelVersionPermission`, so the flag is free on both sides. A creator-level column would need a new
lookup **and** a new cache on the purchase path. `cappedTerms` spreads `...terms`, so the flag survives price
capping untouched, and `gatePrices` only reads the two grants — no change.

@ai: Per-version storage, but the _stance_ is catalog-wide ("am I open to generation credit"), so expressing
it per-version means editing every gate. Seed it from a creator-level default in Creator Studio settings,
with bulk apply — exactly the field shape the [bulk grid](./creator-studio-bulk-grid-plan.md) is being
designed for. Storage stays per-version; the default is UX.

## Work

1. **Terms + write path.** `acceptsBlueBuzz` on `ModelVersionTerms`; `buildModelVersionTerms` takes it;
   checkbox in both editors (onsite form + Creator Studio drawer) with explicit "not withdrawable" copy.
2. **Purchase input.** Add `buzzType` to `modelVersionEarlyAccessPurchase` (currently
   `{ modelVersionId, type }`). **Re-validate server-side against the terms** — never trust the client's
   choice.
3. **Charge + payout.** Drop the guard; pass `toAccountType: 'blue'` when the buyer paid blue.
4. **Refund.** Return to the same account type the buyer spent.
5. **Client.** Offer blue in the purchase modal only when the terms allow it, showing the blue balance.
6. **Accounting sweep** — see below.

## Accounting

- **Creator Program** — already correct. Earnings filter on `toAccountType IN ('yellow','green')`, so blue
  income is excluded without further work. Worth an explicit test so it stays that way.
- **Donation goals.** `earlyAccessPurchase` attaches a donation record to the version's EA goal. A blue
  purchase advancing a goal creators read as cash is probably wrong — decide whether blue counts, and if not,
  skip the donation write for blue purchases.
- **Creator Studio earnings page.** Must separate blue from bankable, or it overstates income for exactly
  the creators who opted in.

## Risks

- **The loophole is the whole risk.** Any path where blue enters and yellow leaves converts free credit into
  withdrawable currency. Worth a regression test asserting `toAccountType === fromAccountType` for the
  purchase, not just a careful review.
- **Creator expectation.** "Accept Blue Buzz" reads as "get paid" unless the UI says otherwise.
- **Blue is plentiful.** It is granted by rewards and bundled with Stripe purchases, so opting in likely
  shifts real purchase volume from bankable to non-bankable currency. That is the creator's call to make, but
  the earnings surface should make the split visible before and after.
