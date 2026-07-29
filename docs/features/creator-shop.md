# Creator Shop

> Status: **Design complete, pre-implementation.** Working doc — tracks decisions and changes as we build.
> Plan of record: HackMD `@civitai/S1iNtOxXzl`. UI/UX mockups: `designs/creator-shop.pen`.

Active Creator Program members submit and sell their own **cosmetics** (and, later, **merch**) from a **Shop** tab on their profile. Buyers pay in Buzz; creators keep a share; moderators review submissions before they go live.

## Product decisions (locked during design)

These override the original HackMD plan where they differ:

- **Submission** is limited to **Cosmetic** and **Merch**. Merch ships later — it appears as **"coming soon"** in the UI. No "Model" submission type.
- **Models** are *not* submitted items. A **Shop Settings toggle** auto-includes the creator's existing early-access / paid-access models as a Models section.
- **Featured** items are chosen in **Shop Settings** via a picker (multi-select, cap 6, published-only), *not* drag-arranged. They render as a distinct highlighted band at the top of the shop.
- **Storefront sections** are `Featured / Cosmetics / Merch / Models`. Each shows **all** its items with per-section filters + sort (e.g. Cosmetics: filter by type; sort by price / name / remaining). No separate "view all" pages. Section order is set in Shop Settings.
- **Cosmetics carry quantity / availability** ("X left", Sold out) like the current `/shop`.
- **Owned / Sold-out** states reuse the existing `CosmeticShop` styling (the `Owned` overlay + out-of-stock disabling the CTA), not bespoke overlays.
- The shop lives in the **real profile shell** (left sidebar + top tab-nav), as a new **Shop** tab — not a standalone page.

## Screens (mockups in `designs/creator-shop.pen`)

| Screen | Purpose |
|--------|---------|
| Shop Item Card (component) | Reusable card; cosmetic / merch / model via overrides; New / Owned / Sold-out / availability states |
| Storefront | Profile Shop tab: Featured band + Cosmetics / Merch (soon) / Models sections with per-section filters |
| Owner — Manage Your Shop | Listings table with statuses + moderator rejection reason + resubmit |
| Shop Settings (modal) | Section order, Models toggle, entry to featured picker |
| Feature Picker (modal) | Select cosmetics to feature (cap 6, published-only, pending greyed) |
| Moderator — Review Queue | Two-pane: preview, price/fee, automated checks, concern flags, approve / reject |
| Purchase Modal | Buy-with-Buzz flow |
| Submit Item | Cosmetic + Merch (soon); fee + earnings preview |
| Owner Empty / Non-member Gate | First-run and Creator Program CTA states |

## Data structure

**Verdict: extend the existing cosmetic-shop model — don't greenfield.** The current tables already do ~90% of what a creator cosmetic needs, and reusing them means creator items inherit the purchase / ownership / refund / payout paths for free. This is a *smaller* footprint than the HackMD plan's three new tables (`CreatorShopItem` / `CreatorShop` / `CreatorShopListing`) — we can collapse those into additive nullable columns on existing tables + one tiny settings table.

### Reuse as-is (no schema change)

| Existing | Creator-shop role | Notes |
|----------|-------------------|-------|
| `CosmeticShopItem` (`unitAmount`, `availableFrom/To`, `availableQuantity`, `meta`) | the sellable **listing** + price + **quantity/availability** | `availableQuantity` already delivers requirement #5 ("X left" / Sold out), enforced at purchase via `count(purchases)` |
| `CosmeticShopItem.meta.paidToUserIds` | **creator payout** routing | Mechanism exists; see rate caveat below |
| `UserCosmetic` + `UserCosmeticShopPurchases` | ownership + purchase record + refund | unchanged |

### Additive changes (nullable / defaulted — official shop unaffected)

1. **Authorship** → `Cosmetic.createdById Int?` (+ `creator User?` relation, index). Official cosmetics stay `null`; creator cosmetics carry the author. This is the single most important addition — today cosmetics are admin-authored only.
2. **Review lifecycle** → on `CosmeticShopItem`: `status`, `reviewedById Int?`, `reviewedAt DateTime?`, `rejectionReason String?`, with
   `enum CosmeticShopItemStatus { Draft PendingReview Published Rejected Archived }` defaulting to **`Published`** so existing official items need no backfill. Creator items start `Draft`/`PendingReview`; the public/creator queries add `status = 'Published'` (official items already satisfy it → minimal disturbance).
3. **Per-creator shop settings** → appended to `User.settings` (Json) as `settings.creatorShop` — **no new table** (`{ showModels, featuredItemIds[], description?, coverImageId? }`).
   - **Featured** = `featuredItemIds` (ordered array, app-enforced cap 6) — matches the picker (pick a set; order matters; keep it out of the hot item table).
   - **Models toggle** = `showModels`; when on, the storefront *unions in* the creator's existing early-access / paid-access models — **no item rows created**.
4. **Submission fee, price-change re-review** → live in `CosmeticShopItem.meta` for MVP (`submissionTxId`, `lastApprovedAmount`); no columns needed. Editing `unitAmount` beyond ±25% of `lastApprovedAmount` flips `status → PendingReview` (application logic).

### Why NOT reuse `CosmeticShopSection` for the storefront

The official shop's sections are a **curated CMS** (banner image, `placement`, `published`, moderator-added). The creator shop's "sections" are **derived**: Cosmetics/Merch/Models are just groupings by item kind, Featured is a picked set, Models is a toggle. Modeling those as per-creator `CosmeticShopSection` rows would force a curated-content table to do a derived-grouping job and push a `userId IS NULL` branch into the official shop's hot queries. Cleaner: derive sections from the creator's items by type + the `User.settings.creatorShop` blob, and leave `CosmeticShopSection` untouched. (If creators ever need arbitrary custom sections, the fork is a nullable `CosmeticShopSection.userId` — but the current design doesn't call for it.)

### Caveats / dependencies to confirm before building

- **Payout rate:** the current `paidToUserIds` logic pays out the **full** `unitAmount` (split equally, bank → recipients) — i.e. 100%, platform keeps 0. For the **70/30** split we change the payout amount to 70% and set `paidToUserIds = [creatorId]` at publish. Plumbing reused; rate is a policy change in `purchaseCosmeticShopItem`.
- **Payout is not rolled back** if the transfer fails after a successful purchase (logged to Axiom). Acceptable for Buzz; revisit for merch (pay-on-fulfilment).
- **Models toggle** depends on the existing early/paid-access model system (ModelVersion early access) — the shop only *reads* it; confirm the query for "this user's early/paid-access models."
- **Merch** is a physical product (Printful/Shopify), not a `Cosmetic` — model it as a sibling later; don't shoehorn into `Cosmetic`. The storefront/listing abstraction should leave room for a non-cosmetic item kind.

### Net new vs. plan

- HackMD plan: 3 new tables (`CreatorShopItem`, `CreatorShop`, `CreatorShopListing`).
- This proposal: **2 additive columns/enum on existing tables (`Cosmetic.createdById`, `CosmeticShopItem.status`+review fields) + shop settings as JSON on `User` (no new tables).** Fewer moving parts, shared purchase/payout path.

## Changelog

- **2026-07-01** — Design phase complete; mockups committed (`da5ff8f1d9`). Data-model assessment done: **extend existing cosmetic-shop tables** (additive `Cosmetic.createdById` + `CosmeticShopItem` status/review fields + shop settings as JSON on `User`) rather than the plan's 3 new tables.
