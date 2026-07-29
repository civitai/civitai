# Creator Shop — Proposal & Change Summary

> **Status:** Design complete, pre-implementation. Seeking team feedback on the data-model approach.
> **Mockups:** `designs/creator-shop.pen` · **Living doc:** [`creator-shop.md`](./creator-shop.md) · **Plan of record:** HackMD `@civitai/S1iNtOxXzl`

## TL;DR

- Active **Creator Program** members submit and sell their own **cosmetics** (merch later) from a **Shop** tab on their profile. Buyers pay in **Buzz**; creators keep **70%**; moderators review submissions before they go live.
- **Data model: extend the existing cosmetic-shop tables, don't build new ones.** The current schema already covers pricing, quantity/availability, ownership, purchases, refunds, and a payout path. We add a handful of nullable columns and keep per-creator shop settings as JSON on `User` — **no new tables** — a much smaller footprint than the original plan's three.
- Two things need an explicit owner: the **70/30 payout rate** (today's path pays out 100%) and treating **merch as a separate product** (not a cosmetic).

## What we're building

A creator storefront that lives inside the real profile shell (left sidebar + top tab-nav) as a new **Shop** tab, with sections **Featured / Cosmetics / Merch (coming soon) / Models**. Supporting surfaces: submit-an-item, owner shop management, shop settings (+ featured picker), and a moderator review queue.

### Locked design decisions

- Submissions are **Cosmetic** + **Merch** only; merch is **"coming soon"** in the UI. No "Model" submission type.
- **Models** aren't submitted items — a **Shop Settings toggle** auto-includes the creator's existing early/paid-access models.
- **Featured** items are picked in **Shop Settings** (multi-select, cap 6, published-only); rendered as a highlighted band. Not drag-arranged.
- Each storefront section shows **all** its items with **per-section filters + sort** (e.g. Cosmetics: filter by type; sort by price/name/remaining). No separate "view all" pages.
- Cosmetics carry **quantity/availability** ("X left" / Sold out), reusing the current `/shop` styling.

## Data-model proposal

### Reuse as-is (no schema change)

| Existing table | Creator-shop role |
|---|---|
| `CosmeticShopItem` — `unitAmount`, `availableFrom/To`, `availableQuantity`, `meta` | the sellable **listing**: price + **quantity/availability** (enforced at purchase via `count(purchases)`) |
| `CosmeticShopItem.meta.paidToUserIds` | **creator payout** routing (see rate caveat) |
| `UserCosmetic`, `UserCosmeticShopPurchases` | ownership, purchase records, refunds |

### Additive changes (nullable / defaulted → official `/shop` unaffected)

```prisma
model Cosmetic {
  // ...existing fields...
  createdById Int?   // NEW — author. null = official/admin cosmetic
  creator     User?  @relation("CosmeticCreator", fields: [createdById], references: [id])
}

enum CosmeticShopItemStatus { Draft PendingReview Published Rejected Archived }

model CosmeticShopItem {
  // ...existing fields...
  status          CosmeticShopItemStatus @default(Published) // NEW — existing items default Published (no backfill)
  reviewedById    Int?                                       // NEW
  reviewedAt      DateTime?                                  // NEW
  rejectionReason String?                                    // NEW
  // submission fee + last-approved price live in `meta` (no columns needed for MVP)
}

// Shop settings — appended to User.settings (Json), NO new table:
// user.settings.creatorShop = {
//   showModels:      boolean    // union in early/paid-access models
//   featuredItemIds: number[]   // ordered; app-enforced cap 6
//   description?:    string
//   coverImageId?:   number
// }
```

- **Storefront query** = published `CosmeticShopItem`s whose `cosmetic.createdById = <user>`, grouped by cosmetic `type`; Featured pulled from `user.settings.creatorShop.featuredItemIds`; Models unioned in when `showModels`.
- **Price-change re-review** (±25% rule) and **submission fee** are application logic using `meta` (`lastApprovedAmount`, `submissionTxId`) — no extra columns for MVP.

### Why *not* reuse `CosmeticShopSection`

It's a curated CMS table (banner image, `placement`, `published`, moderator-added). The creator shop's sections are **derived** (grouping by item type + a picked Featured set + a toggle). Reusing it would force a curated-content table into a derived-grouping role and push a `userId IS NULL` branch into the official shop's hot queries. We derive sections instead and leave `CosmeticShopSection` untouched. (Future fork if creators ever need custom sections: a nullable `CosmeticShopSection.userId`.)

### Net vs. original plan

- HackMD plan: **3 new tables** (`CreatorShopItem`, `CreatorShop`, `CreatorShopListing`).
- This proposal: **2 additive columns/enum on existing tables + shop settings as JSON on `User`** — **zero new tables**, shared purchase/payout path.

## Code touchpoints (first pass)

- `src/server/services/cosmetic-shop.service.ts` — `purchaseCosmeticShopItem` (apply **70/30**, set `paidToUserIds = [creator]`); new submit/review/publish service fns; storefront read scoped by `createdById` + `status`.
- `src/server/routers/cosmetic-shop.router.ts` — creator-facing procedures (submit, edit, archive, set-featured, shop-settings) gated to the item owner; moderator review/approve/reject procedures.
- `src/server/schema/cosmetic-shop.schema.ts` — extend `cosmeticShopItemMeta` (fee, `lastApprovedAmount`); status + settings input schemas.
- Migration SQL committed for review and **applied manually** (we do not run `prisma migrate deploy`).

## Open questions / asks for the team

1. **Payout rate:** today's `paidToUserIds` path pays out the **full** price (platform keeps 0). Confirm **70/30** and that the platform retains 30% — this is a policy change in `purchaseCosmeticShopItem`, not new plumbing.
2. **Status on the listing vs. the asset:** proposal puts review `status` on `CosmeticShopItem` (the listing) and authorship on `Cosmetic` (the asset). Agree?
3. **Featured storage:** ordered `featuredItemIds` in `User.settings.creatorShop` vs. a flag on the listing. (Recommendation: the array — order matters, cap 6, keeps the hot item table clean.)
4. **Models toggle source:** confirm the query for "this user's early/paid-access models" (existing early-access system) the shop should union in.
5. **Merch:** agree to model as a separate product (Printful/Shopify), not a `Cosmetic`, when we get to it.

## Screens (in `designs/creator-shop.pen`)

Storefront · Submit Item · Owner Manage · Shop Settings (modal) · Feature Picker (modal) · Moderator Review Queue · Purchase Modal · Owner Empty + Non-member Gate · reusable Shop Item Card.
