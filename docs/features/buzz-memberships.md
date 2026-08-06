# Buzz-purchased memberships (perks-only)

Lets a user spend Buzz on **one month** of membership _perks_ — the tier's generation
limits, priority, vault, private models and support level — without any of the things that
only make sense when real money changed hands.

## What a Buzz membership does NOT include

- Monthly Buzz
- Bonus Buzz on purchases
- Bonus Buzz on daily rewards
- The monthly badge / cosmetics
- Anything Creator Program: membership, banking caps, and cash out

## How this fits the existing `Civitai` provider catalog

Everything below follows two patterns already in production on the `Civitai` provider —
no new columns, no migration.

**The three real membership products** are the cash tiers redeemable codes grant against.
Note that every numeric value is stored as a **string** (Stripe-style metadata), which is
why the schema uses `z.coerce`/`booleanString`:

| Product          | Price                                | metadata                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `civitai-bronze` | `bronze-monthly`, `unitAmount: 1000` | `tier: bronze`, `level: "1"`, `monthlyBuzz: "10000"`, `rewardsMultiplier: "1.5"`, `purchasesMultiplier: "1.05"`, `badgeType: static`, `badge`, `queueLimit: "8"`, `quantityLimit: "8"`, `vaultSizeKb`, `steps`, `resources` |
| `civitai-silver` | `silver-monthly`, `unitAmount: 2500` | same shape, `level: "2"`, `monthlyBuzz: "25000"`, `rewardsMultiplier: "2.5"`, `purchasesMultiplier: "1.10"`                                                                                                                 |
| `civitai-gold`   | `gold-monthly`, `unitAmount: 5000`   | same shape, `level: "3"`, `monthlyBuzz: "50000"`, `rewardsMultiplier: "4"`, `purchasesMultiplier: "1.20"`, `badgeType: animated`                                                                                            |

**The three referral-perks products** (`civitai-referral-{bronze,silver,gold}`, "Referral
Bronze Perks", …) are the precedent this feature copies. They are perks-only grants that
deliberately carry `monthlyBuzz: 0`, and they are identified by a plain boolean marker in
product metadata — `referralGrantable: true`. Buzz memberships use the same shape with
`buzzPurchase: true`.

Note none of the existing `Civitai` products set `buzzType` in metadata at all, so they
fall through to the schema default (`yellow`).

## Three things called "buzz type" — don't conflate them

|                                  | Meaning                                                                                                                                                                                     | Values here                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Product.metadata.buzzType`      | On the CASH tiers: the colour granted, and the catalog filter. **Absent on Buzz products** — they grant nothing, so `getPlans` skips this filter for them and one catalog serves both sites | _(unset)_                                            |
| `CustomerSubscription.buzzType`  | The subscription **kind**, i.e. which `@@unique([userId, buzzType])` slot the row occupies                                                                                                  | `buzzPurchase` (`BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE`) |
| The account **actually debited** | The calling domain's currency — `getAllowedAccountTypes(ctx.features)` at the router                                                                                                        | `green` on .com, `yellow` on .red                    |

### The paid currency is the domain's, and the user can't change it

Green on civitai.com, Yellow on civitai.red — the same rule as every other Buzz spend on
the site. There is no currency picker.

It is resolved **server-side** in the router from `ctx.features`, exactly like
`purchaseShopItem` does, and is deliberately not part of the mutation input — otherwise a
crafted request could spend the other colour. `purchaseMembershipWithBuzz` additionally
refuses anything that isn't Green or Yellow at the point of the debit, so Blue can't buy a
membership even if a future caller passes it.

### One catalog, both sites

There are **three** Buzz products in total, not three per site. They grant no Buzz, so
there's no colour to tag them with and nothing to split civitai.com from civitai.red over
— `getPlans` skips its `buzzType` filter whenever `buzzPurchase` is set, and the seed
script strips the key rather than writing one.

The knock-on: `PlanBenefitList` has colour-specific default perks keyed on `buzzType`, so
`PlanCard` and `/pricing/buzz` feed it the **current site's** colour for these products
instead of the product's (which no longer has one).

### The subscription slot

⚠️ **`CustomerSubscription.buzzType` is not safe to feed to currency lookups.** For a Buzz
membership it holds `'buzzPurchase'` (and for a referral grant, `'referral'`) — neither is a
Buzz colour, so `getBuzzCurrencyConfig` returned `undefined` and every consumer crashed on
`config.icon`. Use `getSubscriptionDisplayBuzzType(sub.buzzType, siteBuzzType)` wherever the
column feeds display; `getBuzzCurrencyConfig` also falls back to yellow now rather than
returning undefined.

**Never render the cash price for one.** The `Price` row carries the USD amount purely so
the Buzz cost can be derived from it — no money changed hands. `/user/membership`,
`PlanCard` and `Account/SubscriptionCard` all show `getBuzzMembershipPrice(...)` Buzz
instead when `buzzPurchase` is set.

**Never label one with a Buzz colour.** They grant no coloured Buzz, so "Your Green
membership benefits" / a green pill / "Green Buzz per month" all claim something untrue.
The membership-page heading drops the colour word and the account card's colour pill becomes
a "Buzz purchase" badge.

**They're not a discontinued plan.** `MembershipPlans.currentMembershipUnavailable` (and the
sibling `activeSubscriptionIsNotDefaultProvider`) flag a subscription that's missing from the
catalog or on another provider — both true of a Buzz membership by design, neither meaning
what the alert says. Both now skip `buzzPurchase` subscriptions.

**Tier matching must not cross the Buzz/cash boundary.** `PlanCard._isActivePlan` matched on
tier, so a Buzz bronze marked the _cash_ bronze card "Manage your Membership" — hiding the
upgrade the user is entitled to. Across that boundary only an exact product-id match counts.

**Civitai provider ≠ prepaid.** `/user/membership` gated its prepaid-token UI (timeline,
token overview, redeemable-codes card, "tokens unlock monthly" copy) on
`isCivitaiProvider`. Buzz memberships are on that provider but are not tokenized — they have
no tokens and no code — so the page presented one as a prepaid membership. Those blocks now
gate on `isPrepaidMembership = isCivitaiProvider && !isBuzzMembership`.

Referral grants already do exactly this — 41 live rows carry `buzzType = 'referral'`
against the referral-perks products (`REFERRAL_BUZZ_TYPE` in `referral.service.ts`). A
dedicated slot means a Buzz membership never competes with, overwrites, or has to delete
the user's paid yellow/green row; the "you can't hold both" rule is enforced in the
service as a business rule, not by the storage layout.

The catch: `getUserSubscription` (and `useActiveSubscription` on top of it) look up a
**single** slot, defaulting to `yellow` — so a Buzz membership was invisible to every
surface built on it (`/user/membership`, account settings, the pricing page's "you are X").
`getUserSubscription` therefore takes **`includeBuzzPurchase`**, which falls back to the
`buzzPurchase` slot when the requested one is empty.

It is **opt-in, not automatic**, and that matters: `/user/membership` and the account card
each call the hook twice — once for the current site's colour, once for the _other_ colour
to decide whether to show "you have a membership on the other site". An unconditional
fallback answered both with the same Buzz membership, producing a bogus cross-site banner.
Set the flag on the "does this user have a membership" lookup; never on the "do they have
one over there" probe.

Two knock-ons of that fallback:

- `PlanCard`'s `disabledDueToProvider` compares providers; a Buzz membership is on the
  Civitai provider, so it would have disabled every Stripe cash plan. It now ignores
  `buzzPurchase` subscriptions — paid memberships take priority, so they must stay
  purchasable.
- `/user/membership`'s `getServerSideProps` gate keys on `session.user.subscriptionId /
memberInBadState / tier`, none of which a Buzz purchase sets, so it bounced these users to
  `/pricing`. It now checks the `buzzPurchase` slot directly before redirecting, and the page
  leads with a banner naming the membership, its expiry, that it doesn't renew, and what it
  excludes.

`getAllUserSubscriptions` / `getHighestTierSubscription` were always buzzType-agnostic and
see it, which is what the tier resolution, the purchase guard, and `/pricing/buzz` use.

## Product setup — run the seed script

**`scripts/oneoffs/seed-buzz-membership-products.sql`** creates the whole catalog:

```bash
psql "$DATABASE_URL" -f scripts/oneoffs/seed-buzz-membership-products.sql
```

It copies the perks (badge, vault size, queue/quantity limits, steps, resources, level)
straight from the live `civitai-bronze` / `-silver` / `-gold` products and overrides only
the money-side keys, so the Buzz tiers can't drift from the cash tiers they mirror. It is
idempotent, aborts rather than half-seeding if the cash catalog isn't what it expects, and
finishes with a SELECT showing what each tier will cost. Nothing to edit and no per-site
config — run it once per database and both sites get the catalog.

Nothing becomes visible just from running it: `getPlans` only returns these products when
asked for the Buzz catalog, which only happens behind the `buzzMemberships` flag. The
script's footer has the "pull it back off sale" statements (deactivate, never delete —
live `CustomerSubscription` rows reference these products).

### What it writes, and why

One product per tier, one **monthly** price each, on the `Civitai` provider. Product
metadata:

| Key                   | Value                          | Why                                                                            |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `tier`                | `bronze` \| `silver` \| `gold` | Same tiers as cash — checks throughout the app stay blank tier checks          |
| `buzzPurchase`        | `true`                         | Marks the product as the perks-only Buzz catalog (mirrors `referralGrantable`) |
| `badgeType`           | `none`                         | No monthly badge — renders "No monthly badge" on the plan card                 |
| `monthlyBuzz`         | _removed_                      | See note below — the removal is load-bearing                                   |
| `purchasesMultiplier` | `1`                            | Renders as "No Bonus Buzz on purchases"                                        |
| `rewardsMultiplier`   | `1`                            | Renders as "No Bonus Buzz on daily rewards"                                    |
| `buzzPrice`           | _(optional)_                   | Explicit per-month Buzz price; otherwise derived                               |

Everything else — `queueLimit`, `quantityLimit`, `vaultSizeKb`, `steps`, `resources`,
`badge`, `badgeType` — is copied verbatim from the matching cash product. Those are the
perks being sold, so they should never diverge.

`Price.unitAmount` mirrors the cash plan (the script copies it). The Buzz price is derived
from it as `dollars × 1000 buzz/$ × 1.25` (`getBuzzMembershipPrice`), so with today's cash
prices:

| Tier   | Cash   | Buzz   |
| ------ | ------ | ------ |
| Bronze | $10.00 | 12,500 |
| Silver | $25.00 | 31,250 |
| Gold   | $50.00 | 62,500 |

Set `buzzPrice` in metadata to override.

### `monthlyBuzz` is removed, not set to 0

`deliverMonthlyCosmetics` and the prepaid-token unlock cron both filter on
`pr.metadata->>'monthlyBuzz' IS NOT NULL`, so an absent key keeps **both** crons off these
rows — no monthly Buzz and, deliberately, no monthly badge. (`0` would have kept them in
scope, which is why it isn't used here even though the referral-perks products do.)

That's defence in depth rather than the primary guard: `deliverMonthlyCosmetics` also
excludes `buzzPurchase` products outright, and `purchaseMembershipWithBuzz` doesn't call it
at all. Adding a `monthlyBuzz` key back to one of these products still won't start granting
badges.

The plan card reads "0 Buzz per month" either way — `getPlanDetails` falls back to 0 when
the key is missing.

## Rules

- **One month at a time.** No quantity selector, no stockpiling. Buying another month is
  a fresh, explicit purchase after the current one lapses.
- **No auto-renew.** The row is written with `cancelAtPeriodEnd: true`.
- **Mutually exclusive with any other membership.** Refused if the user holds any
  non-bad-state subscription that hasn't lapsed — paid, referral, or another Buzz one.
  Checked twice: once up front for a clean error, and again inside the write transaction,
  because the Buzz charge in between is a network round trip.
- **Repeat purchases upsert** into the `buzzPurchase` slot. Nothing is deleted — the
  in-transaction check has already proved the row being overwritten is lapsed.
- **Paid in the domain's currency.** Green on .com, Yellow on .red, resolved server-side —
  no picker, and Blue is refused at the debit.

## Where the "paid membership" distinction is enforced

`getHighestPaidTierSubscription` (`subscriptions.service.ts`) is
`getHighestTierSubscription` with `buzzPurchase` products filtered out. Cash-gated paths
resolve their tier through it:

- `hasValidCreatorMembership` — Creator Program join/validity
- `queryValidCreatorMembership` (`creator-membership.service.ts`) — the batched,
  cache-backed twin of the above, used for read-time metric-privacy gating
- `bankBuzz` — rejects a `buzzPurchase` product outright
- the banking-cap lookup in `creator-program.service.ts` — excluded in SQL, so a Buzz
  membership can't raise a cap either

Monthly badges are separately excluded — see `deliverMonthlyCosmetics` above.

**And the plan card has to say so.** `PlanBenefitList`'s `defaultBenefits` had the
"Creator Program: earn from your Buzz" line gated only on `tier`, so a Buzz _gold_ card
advertised it as included. It now carries a `creatorProgram: true` marker, and the
component takes a `creatorProgramDisabled` prop that `PlanCard` sets for `buzzPurchase`
products and `/pricing/buzz` sets always — rendering it crossed-out/grey like any other
unavailable perk. Tag any future Creator-Program-only perk the same way.

**Not** tagged: "Higher licensing-fee & paid-access price caps at higher tiers". Those caps
ride on the tier itself rather than on Creator Program membership, so Buzz memberships keep
them. There's a comment on the entry saying so — don't "fix" it by adding the marker.

Everything else (generation limits, vault, private models, priority) is a plain tier check
and is _meant_ to see the Buzz membership.

## Rollout

Gated on the `buzzMemberships` feature flag (`buzz-memberships` in Flipt; mods by
default). It gates the pricing-page toggle and `/pricing/buzz`; the server mutation is not
flag-gated but is inert until Buzz products exist in the catalog.

## Buying a cash membership ends the Buzz one

The cash flows (`upsertSubscription` for Stripe, `consumeRedeemableCode` for membership
codes) upsert keyed on `userId_buzzType` with the **cash** colour, so they never touch the
`buzzPurchase` slot. Left alone, a user would hold both — and since tier resolution takes
the HIGHEST tier across all subscriptions, a leftover Buzz gold would keep granting gold
perks to someone now paying for bronze.

Both paths therefore call `supersedeBuzzMembershipForPaidSubscription({ userId })` once the
paid subscription is active (`active`/`trialing` only — a cancellation webhook must not
trigger it). It sets the Buzz row to `canceled` with `canceledAt`/`endedAt`, then busts the
caches. Cancelled rather than deleted so the purchase stays auditable;
`getAllUserSubscriptions` filters cancelled rows either way.

Note this means a user who upgrades to cash **forfeits the remainder of the Buzz month**.
The original discussion left that unresolved — Justin didn't want people losing time they'd
paid for, but never landed on a way to track the overlap. If you want the remainder honoured
instead, this function is the single place to change.

## Cache invalidation

`purchaseMembershipWithBuzz` and `supersedeBuzzMembershipForPaidSubscription` both call
`invalidateSubscriptionCaches(userId)` — the same fan-out every other subscription mutation
uses: session refresh, reward/purchase multipliers, vault size, the Creator Program cap
cache, the Civitai-user cache, and the creator-membership-validity cache.

## Entry points

- `/pricing` — cash catalog only. Carries a blue alert (styled like the "moved to
  civitai.red" one) pointing at the Buzz catalog. There is **no** pay-with toggle; a
  segmented control put a second currency on a page that's about the cash plans.
- `/pricing/buzz` — the Buzz catalog: the shared `BuzzMembershipCallout` plus the same three
  `PlanCard`s `/pricing` uses. The card **is** the checkout — its "Get X with Buzz" button
  runs `purchaseWithBuzz` directly, since there's nothing to configure past the tier.
- `YellowMembershipUnavailable` (civitai.red `/pricing`) — third callout box alongside "Buy
  Buzz" and "Green Membership", linking to `/pricing/buzz`.
- `BuzzMembershipCallout` — the one description of what these are and aren't, shared by
  `/pricing/buzz` (titled "Perks membership") and `/user/membership` (titled "<Tier> Perks",
  with the expiry). Keep it shared so the two can't drift.
- `subscriptions.purchaseWithBuzz` — tRPC mutation
- `purchaseMembershipWithBuzz` — `src/server/services/subscriptions.service.ts`
- `getBuzzMembershipPrice`, `BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE`,
  `getSubscriptionDisplayBuzzType` — `src/shared/utils/buzz-membership.ts`
- `scripts/oneoffs/seed-buzz-membership-products.sql` — catalog seed
