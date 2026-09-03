# Paid access — open threads

> **Status:** notes, nothing decided. Raised in a call with Justin, 2026-09-03. Kept here so they are
> not lost between the two design docs they touch —
> [paid-access-decay.md](paid-access-decay.md) and [donation-goals.md](donation-goals.md).
> Owner: unassigned.

Four thoughts about the shape of `PaidAccess` itself, none blocking, recorded with an assessment
each so the reasoning is not re-run from scratch.

## 1. Rename `PaidAccess` to something that reads as a sellable item

The current name describes a **gate** rather than a **thing offered for sale**, which is awkward once
the same record has to cover cosmetics or any other digital good.

**Suggested: `Listing`.** Retail vernacular, a creator would recognise it, and it extends to anything
sellable without implying a gate.

🔑 **The rename also fixes a worse problem.** `PaidAccess` and `EntityAccess` are the two halves of
one transaction — the offer and the receipt — with near-identical names. Every document in this area
has had to write "the config side" and "the purchase side" to disambiguate them. `Listing` +
`EntityAccess` reads correctly with no gloss.

## 2. A `goods` table, or does `PaidAccess` cover cosmetic sales?

**Assessment: not yet, and probably not as a single table.**

Cosmetics already have a full storefront. `CosmeticShopItem` carries `unitAmount`, `availableFrom`,
`availableTo` and `availableQuantity`, surrounded by **nine** tables — sections, wishlists, resales,
packs, purchases, and a review workflow (`status`, `reviewedById`, `rejectionReason`).

The overlap with `PaidAccess` is essentially the price. Everything else diverges:

| Cosmetics have | Paid access has |
|---|---|
| stock limits, resale, wishlists, packs, moderation review | polymorphic entity, per-grant pricing, trials, time windows |

A unified `goods` table either carries both feature sets — leaving most rows mostly null — or becomes
a thin spine holding a price and a type discriminator while the real data stays in two detail tables.
Only the second is sane, and a spine sharing one column does not pay for the migration.

**The duplication worth attacking is the purchase side instead.** `EntityAccess` and
`UserCosmeticShopPurchases` are both *"user X bought thing Y"*. That is a genuine overlap, and it is
where one unified surface — "what has this user bought" — would actually pay off.

## 3. `PaidAccessPriceStep` could implement early access

A step with a price of 0 after N days **is** early access. `endsAt` and `timeframeDays` stop being
primary and become derived.

**Assessment: the strongest of the four — it makes the system smaller.** It also composes with what
is already decided: a step reaching zero resolves to the **free state** rather than a price of 0 (to
avoid a zero-Buzz charge that writes no ledger row), so "step to 0 at day N" and "early access ends at
day N" are already the same thing.

Best of all, it dissolves the question that started this whole line of work — *is this early access or
paid access?* — by removing the distinction rather than reconciling it.

⚠️ **The cost is in the read paths, not the schema.** `process-ending-early-access`, feed filters, the
early-access badge and Meilisearch indexing all currently key on a **date they can filter on**, not a
ladder they must evaluate. Workable — keep `endsAt` as a *materialized projection* of the ladder
rather than the source of truth — but that projection is the actual work, and it is more than the
schema change suggests.

## 4. A price step keyed on purchase count

Early-bird pricing: the first N buyers pay less.

**Assessment: a different feature wearing the same table's clothes.** Worth doing, worth deciding
deliberately, not worth adding as a step `kind`.

🔴 **It inverts the ladder's direction.** Every decision so far assumes prices only decay —
`ReduceBy`/`SetTo`, latest elapsed step wins, steps never compound, and a step can never make a free
thing cost money. Early-bird means the price **rises** after N buyers. Mixing time-decay and
count-escalation in one table means *"will this price go up?"* no longer has a single answer, which was
the explicit reason for making mode uniform per ladder.

Two smaller wrinkles: a count-based price needs a **live purchase count on every price resolution**
(cacheable, but not free the way a date comparison is), and the boundary needs a rule for two people
buying at the same moment.

If it is adopted, adopt it as *"we now allow rising prices"* — a product decision with its own
disclosure requirements — rather than as a new column.

## Price tags — a competing direction for templates

Not from the same call, but the same axis. See
[pricing-templates.md](pricing-templates.md#price-tags--a-competing-direction) for the full thread and
its consequences: Justin proposed replacing base-model/type template targeting with creator-named
**price tags**, and it is agreed in principle with no implementation decision recorded.

⏸ **Its review is deferred** until the `DonationGoal` keep-or-drop question is answered — see
[donation-goals.md](donation-goals.md#whether-to-keep-donation-goals-at-all).
