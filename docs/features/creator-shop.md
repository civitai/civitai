# Creator Shop

> Status: **Built and live** (cosmetics; merch not started). Working doc — tracks decisions and changes as we build.
> Plan of record: HackMD `@civitai/S1iNtOxXzl`. UI/UX mockups: `designs/creator-shop.pen`.

Active Creator Program members submit and sell their own **cosmetics** (and, later, **merch**) from a **Shop** tab on their profile. Buyers pay in Buzz; creators keep a share; moderators review submissions before they go live.

## Product decisions (locked during design)

These override the original HackMD plan where they differ:

- **Submission** is limited to **Cosmetic** and **Merch**. Merch ships later — it appears as **"coming soon"** in the UI. No "Model" submission type.
- **Models** are _not_ submitted items. A **Shop Settings toggle** auto-includes the creator's existing early-access / paid-access models as a Models section.
- **Featured** items are chosen in **Shop Settings** via a picker (multi-select, cap 6, published-only), _not_ drag-arranged. They render as a distinct highlighted band at the top of the shop.
- **Storefront sections** are `Featured / Cosmetics / Merch / Models`. Each shows **all** its items with per-section filters + sort (e.g. Cosmetics: filter by type; sort by price / name / remaining). No separate "view all" pages. Section order is set in Shop Settings.
- **Cosmetics carry quantity / availability** ("X left", Sold out) like the current `/shop`.
- **Owned / Sold-out** states reuse the existing `CosmeticShop` styling (the `Owned` overlay + out-of-stock disabling the CTA), not bespoke overlays.
- The shop lives in the **real profile shell** (left sidebar + top tab-nav), as a new **Shop** tab — not a standalone page.

## Rights affirmation

Submitting a cosmetic requires the creator to confirm they own — or otherwise hold — the rights to sell the artwork. It is not just a client-side checkbox: the service records `meta.rightsAffirmation` on the `CosmeticShopItem` (`userId`, `affirmedAt`, `version`, and the `statement` verbatim), so a later takedown challenge can show who agreed to what, and when.

- The wording and version live in `creator-shop.schema.ts` (`RIGHTS_AFFIRMATION_STATEMENT` / `RIGHTS_AFFIRMATION_VERSION`) — bump the version whenever the wording changes; existing records keep the text that was actually agreed to.
- Replacing artwork on an unpublished item re-affirms (and overwrites the record), because the stored affirmation describes the art it was made against. A moderator swapping artwork does not affirm and does not overwrite the creator's record.
- The moderator review queue shows the affirmation alongside the automated checks.

## Cross-creator resale (`UserCosmeticShopItemResale`)

A creator marks an item `meta.sellableByOthers` with a `meta.sellerShare` (0–70, the reseller's cut of the creator's 70% pool). Other creators then list it — by reference, one inventory — in their own shops. Because the original creator still owns those two settings, they could advertise a 50% share, wait for others to build a storefront around it, then drop it to 0 or switch resale off entirely.

**Each listing is a row**, `UserCosmeticShopItemResale (userId, shopItemId, sellerShare, index, createdAt)`, and `sellerShare` is captured when the row is created and never rewritten. The row is the record of _both_ halves of the deal:

- **It is the terms.** `purchaseCosmeticShopItem` pays the reseller `listing.sellerShare`, never the item's current one. A single PK lookup (`userId_shopItemId`), no settings blob.
- **It is the permission.** The storefront selects the Resold section straight from the reseller's rows, so it no longer re-checks `sellableByOthers` at read time — an existing listing survives the creator withdrawing resale. `sellableByOthers` still gates `addResoldItem`, i.e. _new_ listings.
- `index` is the creator's storefront order (`reorderResoldItems`); `createdAt` is when they listed.

### Withdrawing an item ends its resale listings

Grandfathering covers the **terms**, not the item's continued existence. Delisting, archiving or taking down an item runs `endResaleListings`: the rows are deleted and every affected creator gets a `creator-shop-resale-ended` notification. Nobody is left with a card that can't sell, and nobody holds a claim to a share on something that isn't for sale.

**Coming back requires a new review.** Re-listing (`setCreatorShopItemListed({ listed: true })`) and restoring from the archive (`unarchiveCreatorShopItem`) both set `PendingReview` and clear the previous verdict, rather than returning the item straight to sale. That is what keeps ending the listings fair: without it, _withdraw → re-list_ would be a one-click way to clear every reseller and re-offer the item at a worse share — the exact bait-and-switch this ticket exists to prevent. Delisting itself doesn't touch the status; only the return trip does.

**An item in a creator mystery pack on sale stays available to the pack.** While a creator's own listing of an item is an enabled content of their published mystery pack, they can't archive it or cap its stock (`assertNotInLiveMysteryPack`). Delisting, re-listing and repricing are allowed: a delisted item stays in the pack as box-only, and the pack keeps the item values it was approved with. An item sent back to review fails the pack's content checks at the pack's next edit, and at a moderator's approval of one, until the item is approved again. Moderators are exempt.

**Mystery packs go through the same queue.** A creator's pack is a box listing whose box has a seller. The review queue shows packs in its unfiltered view and under the `MysteryPack` type filter, and a pack on sale with an edit waiting counts as pending review. Its pane (`getMysteryPackReview`) shows the edit checked as approval would check it, its odds and value against its price, what it changes from the live version, and shelf sales for any item valued over 5,000. Moderator delete refuses a pack's listing, which would leave the box behind. `reviewCreatorShopItem` hands a pack's verdict to `reviewMysteryPack` (`creator-mystery-pack-approve.service.ts`), which reviews the pending edit (named by `boxRevisionId`) as well as the listing: approving re-runs the content checks, then applies the edit as a new version at the proposed price. Rejecting a pack that was never approved is final; on an approved pack, reject (like request-changes) only turns the edit down. A creator can lower a live pack's price without review (`lowerMysteryPackPrice`); raising it is an edit and goes to review. A creator can have at most 5 packs on sale or in review, not counting archived boxes (`MAX_LIVE_MYSTERY_PACKS`). An approved pack is not yet for sale: the box purchase, the moderator grant and opening all refuse a box with a seller.

`addResoldItem` correspondingly refuses an item that is currently off sale, so a row can only ever be created while the item was live. The resale picker still shows off-sale items (so the reseller doesn't have to hunt for them later), badged and with Add disabled.

Both directions are indexed, which is why this is a table and not JSON on `User.settings`:

- **"What do I resell?"** — PK prefix on `userId` (`getResoldItemsForManage`, the storefront).
- **"Who resells my item?"** — `UserCosmeticShopItemResale_shopItemId_idx` (`getShopItemResellers`, plus a `_count` on the manage list). Answering this from the old `settings.creatorShop.resoldItemIds` array meant scanning every user's JSON.

Manage-view stats (`getCreatorShopResaleStats`, one aggregate over both directions) show **Resellers** — _distinct_ creators reselling your items, with the number of your items involved — and **You resell**, how many of other creators' items you list. Per-item, the manage table shows the reseller count and opens a popover of who they are and on what terms, which is what a creator wants in front of them before touching the item's resale settings.

The original creator can change `sellableByOthers` / `sellerShare` at any time from the item's edit modal — they are payment terms like price and `acceptsBlueBuzz`, so the edit stays live rather than re-entering review, and a cross-lister is refused them the same way they're refused the artwork. Grandfathering is what makes that safe: the change is an offer to _future_ resellers only. When the item already has resellers the modal says so, with the share they keep.

Withdrawal is disclosed at the point of action: delisting or archiving asks for confirmation first, naming how many creators' listings it will end and warning that the item needs a new review to come back.

Bounds of the guarantee:

- **It covers the terms, not the item.** Switching resale off leaves existing resellers alone; delisting or archiving the item ends their listings (with notice, and at the cost of a re-review to undo).
- **Withdrawing resale still works** — for everyone who had not listed the item yet. Only rows that already exist survive it.
- **Switching resale off zeroes the item's `sellerShare`** (mirroring submit), so toggling it back on can't quietly restore a share the creator had retired.
- **Terms are literally the ones agreed to.** A creator _raising_ the share does not raise it for existing resellers either — they keep what they listed under until they relist.
- **Removing a listing deletes the row**, so relisting later is a fresh agreement to whatever the item offers then. Deleting the shop item cascades the rows away.
- `sellerShare` is never part of a tRPC input — `addResoldItem` reads it off the item, and `reorderResoldItems` only writes `index`, so a client can't grant itself terms.

## Screens (mockups in `designs/creator-shop.pen`)

| Screen                        | Purpose                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Shop Item Card (component)    | Reusable card; cosmetic / merch / model via overrides; New / Owned / Sold-out / availability states   |
| Storefront                    | Profile Shop tab: Featured band + Cosmetics / Merch (soon) / Models sections with per-section filters |
| Owner — Manage Your Shop      | Listings table with statuses + moderator rejection reason + resubmit                                  |
| Shop Settings (modal)         | Section order, Models toggle, entry to featured picker                                                |
| Feature Picker (modal)        | Select cosmetics to feature (cap 6, published-only, pending greyed)                                   |
| Moderator — Review Queue      | Two-pane: preview, price/fee, automated checks, concern flags, approve / reject                       |
| Purchase Modal                | Buy-with-Buzz flow                                                                                    |
| Submit Item                   | Cosmetic + Merch (soon); fee + earnings preview                                                       |
| Owner Empty / Non-member Gate | First-run and Creator Program CTA states                                                              |

## Data structure

**Verdict: extend the existing cosmetic-shop model — don't greenfield.** The current tables already do ~90% of what a creator cosmetic needs, and reusing them means creator items inherit the purchase / ownership / refund / payout paths for free. This is a _smaller_ footprint than the HackMD plan's three new tables (`CreatorShopItem` / `CreatorShop` / `CreatorShopListing`) — we can collapse those into additive nullable columns on existing tables + one tiny settings table.

### Reuse as-is (no schema change)

| Existing                                                                           | Creator-shop role                                            | Notes                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CosmeticShopItem` (`unitAmount`, `availableFrom/To`, `availableQuantity`, `meta`) | the sellable **listing** + price + **quantity/availability** | `availableQuantity` already delivers requirement #5 ("X left" / Sold out), enforced at purchase via `count(purchases)`                                                                                                                                                         |
| `CosmeticShopItem.meta.paidToUserIds`                                              | **legacy official-shop payout** routing                      | Creator items pay `Cosmetic.createdById` its 70% share; `paidToUserIds` survives only for items with no cosmetic creator, where it still splits the **full** price equally with no platform cut (`cosmetic-shop.service.ts`, pinned by `cosmetic-shop-payout.service.test.ts`) |
| `UserCosmetic` + `UserCosmeticShopPurchases`                                       | ownership + purchase record + refund                         | unchanged                                                                                                                                                                                                                                                                      |

### Additive changes (nullable / defaulted — official shop unaffected)

1. **Authorship** → `Cosmetic.createdById Int?` (+ `creator User?` relation, index). Official cosmetics stay `null`; creator cosmetics carry the author. This is the single most important addition — today cosmetics are admin-authored only.
2. **Review lifecycle** → on `CosmeticShopItem`: `status`, `reviewedById Int?`, `reviewedAt DateTime?`, `rejectionReason String?`, with
   `enum CosmeticShopItemStatus { Draft PendingReview Published Rejected Archived }` defaulting to **`Published`** so existing official items need no backfill. Creator items start `Draft`/`PendingReview`; the public/creator queries add `status = 'Published'` (official items already satisfy it → minimal disturbance).
3. **Per-creator shop settings** → appended to `User.settings` (Json) as `settings.creatorShop` — **no new table** (`{ showModels, featuredItemIds[], description?, coverImageId? }`).
   - **Featured** = `featuredItemIds` (ordered array, app-enforced cap 6) — matches the picker (pick a set; order matters; keep it out of the hot item table).
   - **Models toggle** = `showModels`; when on, the storefront _unions in_ the creator's existing early-access / paid-access models — **no item rows created**.
4. **Submission fee, price-change re-review** → live in `CosmeticShopItem.meta` for MVP (`submissionTxId`, `submissionFee`, `lastApprovedAmount`); no columns needed. Editing `unitAmount` beyond ±25% of `lastApprovedAmount` flips `status → PendingReview` (application logic).

### Submission fees are per type and set in the database

The fee is **per `CosmeticType`**, plus one figure for packs, stored in `KeyValue` under `creatorShopFees`
(`{ submission: { Badge: 10000, … }, pack: 1000 }`). A missing or malformed value falls back **per value** to
the compiled default in `creator-shop.schema.ts` (10,000 per type, 1,000 for a pack), so an absent row keeps
today's pricing. Read and set it through `/api/admin/creator-shop-fees`.

One read serves both the charge (`creator-shop.service.ts`) and the quote the submit form shows
(`creatorShop.getFees` → `useCreatorShopFees`); the client never mirrors a constant, because the number a
creator agrees to and the number charged are the same non-refundable Buzz. The submit mutation carries the
quoted fee and the server refuses the submission if it no longer matches, so a form left open across a fee
change is never charged silently. The amount actually charged is recorded on the item as `meta.submissionFee`;
items submitted before that existed show no amount rather than today's configured one.

### Why NOT reuse `CosmeticShopSection` for the storefront

The official shop's sections are a **curated CMS** (banner image, `placement`, `published`, moderator-added). The creator shop's "sections" are **derived**: Cosmetics/Merch/Models are just groupings by item kind, Featured is a picked set, Models is a toggle. Modeling those as per-creator `CosmeticShopSection` rows would force a curated-content table to do a derived-grouping job and push a `userId IS NULL` branch into the official shop's hot queries. Cleaner: derive sections from the creator's items by type + the `User.settings.creatorShop` blob, and leave `CosmeticShopSection` untouched. (If creators ever need arbitrary custom sections, the fork is a nullable `CosmeticShopSection.userId` — but the current design doesn't call for it.)

### Payout rate: built — 70/30

`computeCreatorShopSplit` (`creator-shop.schema.ts`) is the single source of truth: the creator pool is `floor(price × 0.7)`, the platform keeps the remainder, and a resale listing's `sellerShare` comes **out of** the creator's pool, never on top of it. The same function feeds the payout and the submit form's earnings preview, so the previewed number is the paid number. Routing is `Cosmetic.createdById`, not `paidToUserIds` — see the table above.

### Caveats

- **Payout is not rolled back** if the transfer fails after a successful purchase (logged to Axiom). Acceptable for Buzz; revisit for merch (pay-on-fulfilment).
- **Merch** is a physical product (Printful/Shopify), not a `Cosmetic` — model it as a sibling later; don't shoehorn into `Cosmetic`. The storefront/listing abstraction should leave room for a non-cosmetic item kind.

### Net new vs. plan

- HackMD plan: 3 new tables (`CreatorShopItem`, `CreatorShop`, `CreatorShopListing`).
- This proposal: **2 additive columns/enum on existing tables (`Cosmetic.createdById`, `CosmeticShopItem.status`+review fields) + shop settings as JSON on `User` (no new tables).** Fewer moving parts, shared purchase/payout path.

## Takedown (IP / TOS)

`creatorShop.takedownItem` (moderator-only, not flag-gated — it covers official shop items too) is the one-shot undo for a cosmetic that has to be pulled. `takedownCosmeticShopItem` in `creator-shop.service.ts`:

1. **Stops sales first** — `status → Archived`, `listed = false`, `meta.takedown = { reason, moderatorId, at }`, official-shop section links deleted, featured slot freed. A taken-down item can never be unarchived back to sale.
2. **Refunds every buyer** — each unrefunded `UserCosmeticShopPurchases` row is reversed from its Buzz ledger, the same way a withdrawn-item refund reverses it (`reversePurchase`, see "Withdrawn-item refunds"): the buyer's debits are read and classified under the purchase id, every leg is refunded by its own transaction id at most once, and only then is `refunded = true` set. A ledger it can't classify, or whose debits don't add up to the price, leaves the buyer unrefunded and reported in `failures` (stage `refund`). A purchase a withdrawn-item refund has already begun (`meta.withdrawnRefund` on the row) is skipped and listed in the log as `leftToWithdrawnRefund`: that run finishes it. Buyers are only ever refunded — nothing is charged back to them.
3. **Takes back what the seller was paid** — after the buyer, every payout the ledger lists under the purchase is refunded by its transaction id, reseller cut included, whatever `meta.payouts` says. A payout that won't come back does not undo the buyer's refund: it is reported in `failures` (stage `clawback`) with its transaction id, recipient and amount. The result reports `owedBack` / `clawedBack` plus `clawedBackPct`, the share of those sales it represents.
4. **Strips ownership** — `revokeCosmeticsFromUsers` for every `UserCosmetic` row of that cosmetic (buyers, gifts, box draws, and the creator's own approval grant), which also unequips and refreshes entity caches / search indexes.

**Mystery boxes holding the cosmetic** (single items only; `mystery-box-takedown.service.ts`). Right after step 1, its `BoxContent` is disabled in every box, each box changed as a builder save changes it: under the box row lock opens wait on, a new `version`, and that version's `BoxOddsSnapshot` (a draft gets none; a creator box's price and content values carry over). A box that cannot be locked in time is reported in `failures` (stage `box`) and still holds the cosmetic. Then every `BoxOpening` that drew it and is still `granted` is refunded, Justin's decision (2026-10-21): the opening is marked `refunded` and, for a purchased box, its purchase is flagged refunded and stamped `meta.takedownRefund`, then the box's price is returned by refunding the purchase transaction (`boxSourceKey`, through `refundAllLegsByPrefix`, so a refund already made reads as done) and the stamp gets `paidAt`. A refund that fails (a 404 included: the purchase row means the charge happened), or a run that dies after claiming, leaves the stamp without `paidAt`, and **Retry takedown** in the review queue (shown on an archived item carrying `meta.takedown`) runs the takedown again: it pays every purchase still owed, found through the refunded openings, keeps the first takedown's record and archive date, and does not notify the creator again. A box refund paid by hand must also set `paidAt`, or a retry pays it again. A moderator's grant (`mod-grant-…`) returns no Buzz. Each opening is claimed under the holder's item lock with the same two guarded flips the moderator app's box refund makes, so whichever runs first refunds it and the other finds it done. Recorded payouts on a box sale (`meta.payouts`) are refunded by transaction id unless the box's own refund already reversed them; one with no id is charged back from its recipient. A creator box's sale without them is left to a moderator in `failures`. The result reports `boxesPulled`, `boxOpeningsRefunded` and `boxRefundedValue`, apart from the shelf counts. A box listing itself is refused here (`Mystery box listings cannot be taken down here`).

The creator's **submission fee is never refunded** — a takedown is a terms violation.

Steps 1 and 2 run under the per-item refund lock the withdrawn-item and manual refunds hold, so a purchase is never refunded by both. The takedown waits for it, about thirty seconds. If it still can't have it (a long refund, or Redis is unavailable), it runs anyway and logs `Takedown ran without the refund lock`: pulling the item must not wait on either, and a refund running at that moment may then refund a purchase alongside it. The item is re-read from the primary once the lock is held, so the history entry of a refund it waited for is kept.

Money moves are best-effort per buyer: each is retried 3× (1s apart) before it's written off, and failures are collected in `failures` (stage + user + amount) instead of aborting the run. Everything lands in Axiom under `name: 'cosmetic-takedown'` — a start record, one `error` per written-off refund/clawback carrying the ids needed to finish it by hand, and a finish record with the run totals (`error` level if anything failed).

Every approve, request-changes, reject or revert in the review queue is also recorded in the label store (`docs/features/label-store.md`) inside the verdict's transaction; a store failure never blocks the verdict. A takedown is recorded last, in its own transaction once the archive, box pull and refunds are done, so labelling never delays or fails any of them; any failure to record it (the store refusing it, or the transaction not running) logs `shop-label-record-failed` with the item id.

## Withdrawn-item refunds

Rejecting a creator cosmetic that has sold, or archiving one while it is withheld (see "Wearing a creator cosmetic"), refunds its buyers automatically. `creator-shop-withdrawn-refund.service.ts`:

- **Trigger.** `reviewCreatorShopItem` (action `reject`, single cosmetics only) and `archiveCreatorShopItem` (item withheld) write `CosmeticShopItem.meta.withdrawnRefund = { trigger, clawback, userId, at }` in the same update as the verdict or archive, then start `refundWithdrawnShopItem(id, { limit: 25 })` in the request. Any other verdict and `unarchiveCreatorShopItem` clear the marker; buyers whose refund had not begun keep the cosmetic. Packs and mystery boxes are out of scope.
- **Who pays.** The creator, in both cases: the buyer's debits are refunded and the creator's payouts reversed, which may take the creator negative (the ledger exempts refunds from its balance check).
- **Per purchase.** Purchases made up to `at`, still unrefunded and not the creator's own. Each is stamped with the same terms on `UserCosmeticShopPurchases.meta.withdrawnRefund` before any money moves, and a stamped purchase is always finished on its stamp, even after the item's marker is cleared or the item is taken down. Each leg is refunded once (`refund-<transactionId>` on the ledger is checked first; a 409 counts as done only when that refund exists). The holding is revoked, scoped to the purchase's claim key, before the row is marked `refunded`.
- **After.** One `cosmetic-shop-item-refunded` notification per buyer, a `refunded` history entry, and one Axiom record under `name: 'creator-shop-withdrawn-refund'`.
- **Retry.** The request refunds at most 25 purchases. The `creator-shop-withdrawn-refunds` job (every 10 minutes) finishes the rest and anything a Buzz failure, a held lock or a dead process left behind. Runs are serialised per item with a distributed lock.

## Refunding a purchase by hand

`creatorShop.refundPurchases` (moderator only, not flag-gated) refunds named purchases on the same path: `{ buzzTransactionIds (1-50), clawback, reason, dryRun = true }`.

- **Dry run** (the default) moves nothing and lists, per purchase, the debit and payout legs it would reverse and whether each `refund-<id>` is already on the ledger.
- **A real run** reads each paid purchase's ledger, then stamps `{ trigger: 'manual', clawback, userId, at }` on it, reverses it, revokes the holding and marks it `refunded` exactly as above, under the same per-item lock. A purchase it leaves part done is finished by the `creator-shop-withdrawn-refunds` job; calling again refunds nothing twice, so a call that times out is safe to repeat.
- **Taken down midway.** The call checks for a takedown just before the stamp (and refuses the purchase if there is one) and again just after it (and then finishes the purchase as `reject` with `clawback: true`, as the job does for a stamped purchase it finishes on a taken-down item). So a `clawback: false` refund caught by a takedown still reverses the creator's payouts. A takedown archives and refunds under the same lock, so it normally cannot land during the call: it waits, and a purchase the call refunded stays refunded on the call's terms. The checks cover a takedown that runs without the lock (see "Takedown (IP / TOS)") or a lock lost mid-call.
- **Refused:** a purchase not found, the creator's own purchase, a pack, an item that was taken down (checked before each purchase; the takedown refunds those), a purchase whose refund already began with a different `clawback`, and a ledger the run cannot reverse (unexpected transactions, or debits that don't match the price). A ledger refusal is decided before the stamp, so the job does not retry it.
- **After.** One `cosmetic-shop-purchase-refunded` notification per buyer, a `refunded` history entry, and one Axiom record under `name: 'creator-shop-purchase-refund'` with the moderator, reason and per-purchase outcome, written even when the call fails partway. The reason stays out of the history, which the creator can read. A payout that does not come back is logged as it happens.

## Review history

An edit-triggered re-review clears `rejectionReason` / `reviewedById` / `reviewedAt`, so without a log a moderator opening a re-queued item can't tell what the creator changed or what was decided last time. `CosmeticShopItemMeta.history` is that log — a capped (25, oldest dropped first) append-only array on the existing JSON column, no migration:

```ts
{ at, userId, kind: 'submitted' | 'edited' | 'reviewed' | 'takedown' | 'refunded', status?, action?, note?, changes?: [{ field, from?, to? }] }
```

Every writer appends inside the `cosmeticShopItem.update` it was already making (`appendItemHistory` in `creator-shop.data.ts`) — recording history never costs an extra round trip:

- `submitCreatorShopItem` seeds a `submitted` entry.
- `updateCreatorShopItem` appends `edited` with one `changes` row per moved field (name, description, artwork — carrying the **pre-swap `data.url`** — fit offsets, slug, uses, price-per-use, price, quantity), plus a `note` when the edit forced the item back into review and why. An edit that moves nothing appends nothing.
- `reviewCreatorShopItem` appends `reviewed` with the action, the reviewer and the note — which is how the note **survives the next edit clearing `rejectionReason`**.
- `takedownCosmeticShopItem` appends `takedown` alongside the `meta.takedown` record it already writes.
- `refundWithdrawnShopItem` and `refundShopPurchases` append `refunded` after a run that refunded purchases. They are the writers with a statement of their own: a single SQL update that touches only `history`, so it cannot write back meta a verdict changed during the run.

`getCreatorShopReviewQueue` already selects `meta`, so the moderator detail pane renders it (`HistoryCard`, newest-first, previous-vs-current artwork thumbnails on a swap) with no query change. Items predating the feature show an explicit empty state. Moderator-only for now — the creator-facing manage view still shows only the current status + rejection reason.

## Wearing a creator cosmetic

Approval grants the creator their own copy, but owning a creator cosmetic is not enough to wear it. A creator-made cosmetic is **withheld** (`getWithheldCosmeticIds`, `creator-shop-withheld.ts`) unless its creator's own listing is displayable (`isListingDisplayable`, `creator-shop.data.ts`): `Published`, or the last moderator verdict approved it and no edit since changed what holders see (name, description, artwork, fit offsets, slug). Relisting, restoring and a large price edit send an approved item back to review without withholding it. The verdict is kept on `meta.displayApproved`, set by every review and cleared by a creator's displayed-field edit; listings without it fall back to the history. Other creators' cross-listings never count, and cosmetics with no creator are never withheld.

- `equipCosmetic` and `equipCosmeticToEntity` refuse a withheld cosmetic, and re-check after their write (`refuseIfWithheldAfterEquip`), so a verdict landing mid-equip still takes it off.
- A non-approve verdict, or an edit that withholds the item, unequips every holder's copy, worn or placed on content (`unequipWithheldCosmetic`), and refreshes the caches that show it. Re-approval does not re-equip.
- A creator edit reads the listing from the primary and writes it under a row lock, refusing with a conflict if a verdict (or anything but a sale) changed it since the read, so it cannot overwrite a verdict or `displayApproved`.
- A moderator deleting a withheld listing sets `CosmeticFlag.Withheld` on its cosmetic first, so it stays withheld with no listing left; deleting an approved listing leaves holders wearing it.
- `userCosmeticCache` also drops withheld cosmetics on read, for rows worn before unequipping existed.
- `cosmeticEntityCaches` does the same for content decorations, so one placed on content before unequipping existed stops showing.
- `user.getCosmetics` returns `withheld` per item, and the inventory shows "In review, not equipable" instead of Equip.

## Changelog

- **2026-10-20** — Moderators can refund chosen shop purchases in one call (`creatorShop.refundPurchases`, dry run by default); new notification `cosmetic-shop-purchase-refunded` and refund trigger `manual`. No migration.
- **2026-10-20** — Creator cosmetics rejected after selling, or archived while withheld, now refund their buyers automatically: the creator's payouts are reversed (even into a negative balance), the cosmetic is revoked per purchase, and buyers are notified. New job `creator-shop-withdrawn-refunds` (every 10 minutes) finishes what the request starts. New history kind `refunded`; `meta.withdrawnRefund` on the item and on `UserCosmeticShopPurchases`. A takedown no longer refunds a payout the buyer refund already reversed, and leaves purchases a withdrawn refund began. No migration.
- **2026-10-19** — Creator cosmetics whose listing isn't approved, or was edited after approval, can no longer be worn: equip is refused, holders are unequipped on a non-approve verdict or a displayed-field edit, and the inventory marks them "In review, not equipable". No migration.
- **2026-08-05** — Resale listings moved from `User.settings.creatorShop.resoldItemIds` to the `UserCosmeticShopItemResale` table (migration `20260805120000_add_cosmetic_shop_item_resale` — **apply manually**, then run `pnpm tsscript scripts/oneoffs/backfill-cosmetic-resale-listings.ts` to migrate existing resellers off the blob). Each row carries the `sellerShare` it was listed under, so lowering the item's share or turning `sellableByOthers` off no longer changes what an existing reseller is paid or removes the item from their shop; and "who resells my item?" is now an indexed lookup instead of a scan of every user's settings JSON. Creators can now also **edit** `sellableByOthers` / `sellerShare` after publishing without it reaching creators who already list the item. Withdrawing the item itself (delist / archive / takedown) _does_ end their listings, with a notification, and bringing it back re-enters review so the cycle can't be used to reset resale terms.
- **2026-08-05** — Per-item review history recorded on `CosmeticShopItem.meta.history` (submissions, creator edits with before → after per field, verdicts, takedowns) and surfaced in the moderator review queue.
- **2026-08-03** — Purchases now record their payout split **and each payout's transaction id** (`UserCosmeticShopPurchases.meta`, migration `20260803220000_add_cosmetic_purchase_payout_meta` — **apply manually**), so takedowns refund those payouts directly.
- **2026-08-03** — Takedown + refund + clawback path added (`creatorShop.takedownItem`, moderator review-queue "Take down" action).
- **2026-08-03** — Cosmetic submissions now require (and record) a creator affirmation of the rights to sell the artwork.

- **2026-07-01** — Design phase complete; mockups committed (`da5ff8f1d9`). Data-model assessment done: **extend existing cosmetic-shop tables** (additive `Cosmetic.createdById` + `CosmeticShopItem` status/review fields + shop settings as JSON on `User`) rather than the plan's 3 new tables.
