# Knights of New Order: the gold shop

Code: `apps/knights/src/lib/server/shop`, `apps/knights/src/routes/gold` (shop) and `routes/gold/inventory`. Main-app side: `src/pages/api/mod/knights/shop/{membership,cosmetics}.ts`, `src/server/services/knights/shop.service.ts` and `grantMembershipMonths` in `src/server/services/referral.service.ts`. Prices are placeholders until the price sheet is signed off; they live in data.

## Data and deploy

Migration `20270104120000_knights_v2_shop` (by hand, additive: two tables). Order: apply it, deploy the main app (the two endpoints), then Knights, then `pnpm run seed:shop` (dev: it refuses a non-local database; `--print-sql` prints the idempotent INSERT instead).

- `KnightsShopItem`: `kind` (`buzz_pack` | `cosmetic` | `membership`), the reference (`buzz`, `cosmeticId`, or `tier` + `months`), `price` in gold, `active`, `rotating`, `sortOrder`, optional `minRank`. A CHECK ties the columns to the kind. Add, re-price or retire an item with SQL; nothing is deployed.
- `KnightsShopPurchase`: the gold ledger. `requestKey` is the buyer's idempotency key (unique per player; the confirm dialog makes a fresh one each time it opens), `externalKey` is the server's key for the downstream grant (the `UserCosmetic.claimKey`, the membership grant key), `conversionId` links a Buzz pack to its `KnightsGoldConversion`, `dealDay` marks a deal price (one per player, item and UTC day, enforced by a partial unique index).

## Daily stock and deals

`rotation.ts` is pure: for a UTC day, fixed items (`rotating = false`) are always on sale, a seeded pick of `ROTATION_SIZE` (4) of the rotating ones is, and `DEALS_PER_DAY` (2) of that stock carry `DEAL_PERCENT` (20) off. The seed is the date and the item ids (FNV-1a), never row order, so every instance and every hour of the day agree, and the picks change at 00:00 UTC. A deal can be bought once per player per day; after that the card reads "Gone for today". A rank-gated item shows as locked below its rank.

## Spending gold (`purchase.ts`, `buyItem`)

One transaction locks the `NewOrderPlayer` row (the same lock conversion and a career reset take), then in order: refuses no player or a hold (payout block or banned), replays an existing `requestKey`, checks the item is active and in today's stock, that the price the buyer saw is today's price, the Buzz kill switch (Buzz packs only), the rank gate, the deal limit and ownership, then `spendable = max(0, goldEarned - goldConverted)` against the price, and writes the purchase and adds the price to `goldConverted`. Delivery follows:

- **Cosmetic**: the `UserCosmetic` row (`claimKey` = `externalKey`) is inserted in that same transaction, so a cosmetic is granted exactly when the gold is spent. Everything except a Sticker is bought once (also refused when the player already holds it from elsewhere). A Sticker is a row per purchase with `remaining` = the cosmetic's `data.uses`, so a repeat purchase adds uses; a sticker with no `uses` is unlimited and is not sold again. After commit Knights asks the main app to refresh the cosmetic caches (best effort: a failure is logged and the caches expire on their own).
- **Buzz pack**: a `KnightsGoldConversion` row is written in the same transaction and `settleConversion` runs the existing grant, with the conversion's key. An unknown outcome stays pending and `retryPendingConversions` (the tick) pays it once; a definitive Buzz rejection fails the conversion and its purchase and releases the gold. Marking the conversion paid or failed also marks its purchase.
- **Membership**: the main app is asked (`main-app.ts`, `POST /api/mod/knights/shop/membership`) with the purchase's `externalKey`. A 2xx is granted; a 4xx other than 408/429 is final (queue full, tier not configured) and releases the gold; anything else leaves it pending and `retryPendingPurchases` (the tick, not behind the Buzz switch) sends the same key.

Releasing gold is `releaseReservation` (`conversion/convert.ts`): gold reserved at or before a career reset's `startAt` was forfeited by the reset, so a late refusal does not give it back (the player is told); otherwise `goldConverted` drops by the price.

### Why spending adds to `goldConverted`

There is no new column. `goldConverted` already means "earned gold that is no longer the player's to spend": conversions and reservations add to it, `spendable = goldEarned - goldConverted` everywhere, and a career reset sets `goldEarned = goldConverted` (the main-app `resetPlayer` and Knights' `restart.service.ts`), which keeps spent gold, forfeits the rest and needs no change. Purchases, conversions and resets all serialise on the same row lock, so two simultaneous buys cannot spend the same gold. The cost is that `goldConverted` no longer says "converted to Buzz" alone: the shop splits it by purchase kind (`balance.ts`: `converted`, `spent`, `onItsWay`).

## Membership months (main app)

`grantMembershipMonths({ userId, tier, months, key })` reuses the referral queue, the closest existing mechanism that is not a Stripe/Paddle subscription: `grantReferralSubscription` on the user's `CustomerSubscription` with `buzzType = 'referral'`, in 30-day chunks per month. The key is remembered in that row's metadata (`grantKeys`, the last 100) under the row lock, so a replay answers `already` and grants nothing. The grant mints no Buzz (the referral products carry `monthlyBuzz = 0`) and delivers the tier's monthly cosmetics in its own transaction.

Stacking:

- **With a paid subscription**: no interaction. The referral grant is its own row (`userId_buzzType`), the paid one is untouched, and the user's effective tier is the highest of their subscriptions (as for any referral perk).
- **With earlier shop or referral time**: pooled in the referral queue, highest tier first, each chunk keeping its own tier and length. Buying Gold after Silver runs Gold now and Silver after it. The queue holds at most `referrals.maxQueuedDays` (365) days; a purchase past that is refused for good (409 `queue-full`) and the gold is released.
- **Replays and retries**: one purchase is one key, however many times Knights sends it.

The inventory reads the active referral subscription for the tier and end date, plus the days queued after it.

## Equipping

Knights never writes `equippedAt`. `POST /api/mod/knights/shop/cosmetics` (`x-webhook-token`) takes `{ action: 'refresh' | 'equip' | 'unequip', userId, cosmeticId }` and calls the main app's own `equipCosmetic` / `unequipCosmeticByType`, so ownership, event-decoration and withheld rules, the cosmetic caches and the worn-cosmetic queue all run, and the main site shows the item at once. Stickers are used, not equipped. A refusal is a 409 whose message the inventory shows.

## Switches and entry points

`KNIGHTS_SHOP_DISABLED=true` (also `1`, `yes`, `on`) closes the shop and hides its entry points (header gold popover "Visit the shop", the avatar menu and home tile "Shop"); `/gold` then says it is not open. `KNIGHTS_CONVERSION_DISABLED` keeps its meaning for Buzz packs only. The restart-career dialog now lists "Gold you have not yet spent".

## Motion (M9, M10)

`routes/gold/+page.svelte`, `ShopCard.svelte`, `PurchaseDialog.svelte`, `inventory/+page.svelte`. The purse counts down (`tween`, 360ms) only after the server has answered, the dialog fades out, the OWNED seal stamps (`mo-stamp`) and a floater rises; any click or key during the 720ms jumps to the end state. Cards stagger in (first six, 40ms apart), the deal card sheens once on load and every 8s, a Buy pressed without the gold shakes twice and fades in the shortfall line, an equipped item cross-fades to verdigris with the check drawing in. Under `prefers-reduced-motion` the count lands at once, there is no floater, shake or sheen, and the rest are 150ms fades. The coin clink of the design is not built: there is no sound asset for it yet.

## Tests

`shop/purchase.pglite.test.ts` (concurrency, replay, hold, kill switch, insufficient gold, badge once, sticker uses, career reset, Buzz retry and rejection, membership retry, rejection and forfeiture), `shop/rotation.test.ts`, `shop/seed-items.pglite.test.ts`, `shop/main-app.test.ts`, `routes/gold/load.test.ts`; main app: `src/__tests__/pages/api/mod/knights/shop.test.ts` and `grantMembershipMonths` in `src/server/services/__tests__/referral.service.test.ts`.
