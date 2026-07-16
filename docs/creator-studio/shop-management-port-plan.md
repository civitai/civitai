# Creator Shop management — port plan (main app → Creator Studio)

**Goal:** bring the creator-facing **shop management** surface — the page where a creator submits/edits items, sets
prices, reorders their storefront, resells others' cosmetics, and publishes their shop — from the Next.js main app
into the SvelteKit spoke (`apps/creator-studio`). This is the plan doc; nothing is built yet.

Basis: a full read-only map of the main-app implementation (see the file/procedure/schema references inline). The
main app's own storefront **public view** (`user/[username]/shop.tsx`) and the **moderator review queue**
(`moderator/creator-shop.tsx`) are **out of scope** — the Studio manages, the main app keeps hosting the public shop
and moderation.

---

## 1. The key architectural finding (drives everything)

The "Creator Shop" is **not** backed by `CreatorShop`/`Storefront`/`Product` tables. It **reuses the platform cosmetic
tables** plus a JSON blob on the user:

| Piece | Table / location | Ownership key |
|---|---|---|
| The artwork/asset | `Cosmetic` (schema.prisma:3658) | `createdById` = *original creator* (drives payout) |
| The listing (price, qty, status) | `CosmeticShopItem` (3723) | **`addedById` = the seller/lister — this is the management ownership key** |
| Sales records | `UserCosmeticShopPurchases` (3758) | `userId` = buyer; count = `_count.purchases` |
| Storefront config | **`User.settings.creatorShop` JSON** (user.schema.ts:305) | the user row itself |

`CosmeticShopSection*` tables are the **platform** shop's moderator-curated sections — **not** creator storefronts.
Creator storefront "sections" are the JSON `sections[]` array (order + visibility of `featured / cosmetics / resold /
merch / models`).

**Implication:** the spoke needs no schema migration. Reads are kysely against `CosmeticShopItem WHERE addedById =
me` + the `User.settings.creatorShop` blob. Writes are complex and side-effectful (Buzz charge, S3+`sharp` artwork
validation, moderation-state transitions) → they **stay in the main app** and the spoke calls narrow REST endpoints,
exactly like the early-access editor (`POST /api/v1/model-versions/early-access`).

---

## 2. Architecture — where logic runs

Consistent with the studio's §5.1 decision (business logic stays in the main app; the spoke is a thin cross-app client
forwarding the shared `.civitai.com` session cookie):

- **Writes → new main-app REST endpoints** wrapping the existing `creator-shop.service.ts` functions. No logic is
  reimplemented in the spoke — the Buzz fee, `sharp` validation, sha256 dedup, price-change→re-review rule, and
  ownership guards all keep living in the service. Each endpoint is a thin `AuthedEndpoint` that parses the existing
  Zod schema and calls the service fn (mirrors `api/v1/model-versions/early-access.ts`).
- **Reads → kysely in the spoke** for the creator's own items + settings (simple, ownership-scoped). Heavier reads
  (the public resell gallery, the full storefront render payload) get read endpoints or are deferred — see §4.

This keeps the spoke free of `sharp`, S3 signing, Buzz orchestration, and moderation state machines.

---

## 3. Write path — endpoints to add in the main app + spoke client

Existing service fns (in `src/server/services/creator-shop.service.ts`, gated today by
`creatorShopProcedure = protectedProcedure.use(isFlagProtected('creatorShop'))`). Proposed REST surface under
`/api/v1/creator-shop/*`, each forwarding the session cookie:

| Endpoint (new) | Wraps service fn | Existing input schema | Guard / side effects to preserve |
|---|---|---|---|
| `POST /items` | `submitCreatorShopItem` | `submitCreatorShopItemSchema` | `assertCreatorProgramMember`; **Buzz fee `CREATOR_SHOP_SUBMISSION_FEE=10000`** (refunded on failure); S3 fetch + `sharp` validate; sha256 dedup; creates `Cosmetic`+`CosmeticShopItem` (status `PendingReview`) |
| `PATCH /items/:id` | `updateCreatorShopItem` | `updateCreatorShopItemSchema` | `getOwnedItemOrThrow` (`addedById===me`); re-validate replaced art; **>±25% price change on Published → back to `PendingReview`**; cross-listers may change price/qty only |
| `POST /items/:id/archive` / `/unarchive` | `archive`/`unarchiveCreatorShopItem` | `{id}` | owner guard; toggles `status` + `preArchiveStatus` |
| `POST /resold` / `DELETE /resold` | `add`/`removeResoldItem` | `resoldItemSchema {shopItemId}` | `assertCreatorProgramMember` + item must be `sellableByOthers`, Published, not own; edits `settings.resoldItemIds` |
| `PUT /settings` | `updateCreatorShopSettings` | `updateCreatorShopSettingsSchema` | **publish guard: `enabled:true` needs active membership + ≥1 item**; read-merge-write JSON; **also the reorder path** (featured / resold / sections order all go here) |

**Business constants to surface in the spoke (display only):** `COSMETIC_PRICE_FLOOR=500`,
`CREATOR_SHOP_SUBMISSION_FEE=10000`, `CREATOR_SHOP_MAX_FEATURED=6`, creator share `0.7`, price-review threshold `0.25`.
The 70/30 split math (`computeCreatorShopSplit`) can be re-exported to the spoke for the submit form's split preview,
but the actual split payout happens at **purchase** time in `cosmetic-shop.service.ts` (out of scope here).

**Spoke client:** a `lib/server/creator-shop.ts` module mirroring the early-access write client — one function per
endpoint, POSTing to the main app with the forwarded cookie, typed by the shared Zod schemas.

---

## 4. Read path

**Kysely in the spoke (simple, do these):**
- **Manage items** — `CosmeticShopItem WHERE addedById = me` (any status), joined to `Cosmetic`, with
  `_count.purchases` → remaining/soldOut, `status`, `rejectionReason`, `meta`. (Mirrors `getManageItems`.)
- **Settings** — read `User.settings.creatorShop` JSON for the current user.
- **Resold items** — the creator's `settings.resoldItemIds` resolved to items, in saved order.

**Heavier reads — endpoint or defer:**
- **Public resell gallery** (`getPublicShopItems`, infinite, other creators' `sellableByOthers` items) — needed for
  the "resell a cosmetic" picker. Port as a read endpoint or a kysely query with the same filter; paginated.
- **Full storefront render** (`getShop`: cosmetics/featured/resold/settings/earlyAccessModelCount/membershipLapsed) —
  only needed if the Studio shows a live preview. **Recommend deferring** — link out to the existing public storefront
  for preview instead of rebuilding the render payload.
- **Early-access price map** (`getEarlyAccessPrices`) — only for the Models storefront section; defer with the preview.

---

## 5. UI — what to rebuild in Svelte

**Route:** `apps/creator-studio/src/routes/shop/` (the Studio's own management page; the main app's
`user/[username]/shop/manage.tsx` is the reference). The public storefront stays in the main app.

Components to port (React → Svelte 5 / shadcn-svelte). Reference sizes in parens (main-app lines):

| Studio piece | Reference component(s) | Notes / React→Svelte gaps |
|---|---|---|
| Manage page shell + header (Settings / Resell / Submit buttons) | `Manage/ManageHeader` (75) | straightforward |
| Items table (status, price, sold, actions: Edit / Edit&resubmit / Archive / Restore) | `ManageItemsTable` (45) + `manage.columns` (180) | table + row menu |
| Toolbar (status filter / search / sort), stats, empty state, draft banner (publish) | `ManageToolbar`, `ManageStats`, `ManageEmptyState`, `ShopDraftBanner` | |
| **Submit / edit item modal** | `CreatorShopSubmitModal` (302) + `Submit/useSubmitCreatorShopForm` (212) + `Submit/ArtworkField` (78) | **needs a Svelte CF image-upload primitive** (main app uses `useCFImageUpload`); artwork dropzone; price/qty; `sellableByOthers`+`sellerShare` split preview; Buzz-fee confirm |
| **Shop settings modal** (public/private toggle, featured manager, **section reorder**, description) | `CreatorShopSettingsModal` (272) | **dnd reorder** — React `@dnd-kit` → a Svelte dnd lib (e.g. `svelte-dnd-action`) |
| Featured picker (≤6) | `CreatorShopFeaturePickerModal` (188) | |
| Resell picker (infinite gallery + **reorder**) | `Manage/ListExistingModal` (310) | infinite scroll + dnd reorder |

**Cross-cutting new primitives the spoke will need** (don't exist in `@civitai/ui` yet):
1. **Cloudflare-Images upload** — a Svelte equivalent of `useCFImageUpload` (direct-creator-upload flow). Needed by
   the submit form. Reusable beyond the shop (also useful for `coverImageId`).
2. **Drag-and-drop sortable list** — `svelte-dnd-action` (or similar) wrapper, used in two places (section order,
   resell order). Both persist via `PUT /settings`.

No rich text (plain textareas). Client-side artwork pre-validation (`creator-shop.validation.ts`, 97 lines) is pure and
portable.

---

## 6. Gating

Three stacked gates, all already expressible in the spoke:

1. **Feature flag `creatorShop`** — `feature-flags.service.ts:289` (`availability: ['mod']`, Flipt key `creator-shop`).
   Mods-only by default, Flipt-controllable. **The spoke must read this flag** — today it's on `SessionUser.features`
   or resolvable via the hub; wire it into the layout/membership resolver and hide the Shop nav + gate the routes on it.
2. **Creator Program membership** — `assertCreatorProgramMember` (joined CP flag **AND** active subscription). The
   spoke already resolves `membership.isCreatorProgramMember`; add the active-subscription check the service uses.
   Lapsed membership shutters an enabled shop.
3. **Publish guard** — `enabled:true` requires active membership + ≥1 item (enforced in the service; the spoke just
   surfaces the reason).

Every *item* still goes through **moderator review** (`PendingReview → Published / Rejected / RequestedChanges`) in the
main app — the Studio only displays `status` + `rejectionReason` and offers "edit & resubmit."

---

## 7. Dependencies & non-dependencies

- **Buzz** — via the existing service (submission fee; refund on failure). The spoke doesn't touch Buzz directly for
  writes (the endpoint does); the submit form shows the fee and uses a confirm.
- **S3 / Cloudflare Images** — server-side `sharp` validation stays in the main app; the spoke needs only the
  **client CF-upload** primitive (§5).
- **Shopify / Merch** — **not implemented today** (a stub `MerchSection` + "coming soon" label). Nothing to port; keep
  the `merch` section key stubbed. Matches the documented "fast-follow, blocked on a Shopify token."
- **ClickHouse** — **none.** Shop "analytics" are `_count.purchases` from Postgres. No CH work.
- **Notifications** — only on moderator review verdicts (main-app side). Not ported.

---

## 8. Phasing

**Phase 1 — MVP creator management (the core slice):** feature-flag + CP gate; the manage page + items table; the
**submit/edit item** flow (needs the CF-upload primitive) with Buzz-fee confirm; **archive/unarchive**; **settings +
publish** (visibility toggle, description, publish guard). Reads via kysely. ~1,500 lines server+client. This is a
usable, shippable shop-management surface.

**Phase 2 — reselling + storefront curation:** the public resell gallery read + `add/removeResoldItem`; the featured
picker (≤6); **section + resell reordering** (needs the Svelte dnd primitive). Additive.

**Phase 3 — preview & polish:** optional in-Studio storefront preview (`getShop` payload) or just link out to the
public storefront; Models section (early-access prices).

**Fast-follow / not now:** Merch (Shopify) — leave stubbed until the token lands.

---

## 9. Effort & risk

- **Server (main app):** ~5 thin REST endpoints wrapping existing service fns — small, low-risk (the logic already
  exists and is tested in prod). The only new server thought is endpoint shape + per-user rate/ownership already in the
  service.
- **Spoke reads:** straightforward kysely (own items + settings blob).
- **Spoke UI:** the real work — ~2,100 lines of React to re-express in Svelte, **plus two new primitives** (CF image
  upload, dnd sortable) that are the highest-uncertainty items. Recommend building/spiking those two primitives first;
  everything else is form + table + modal work the studio already has patterns for.
- **Gating:** wiring the `creatorShop` feature flag into the spoke is a small but required new piece.

---

## 10. Open questions

- **Feature-flag delivery:** does `SessionUser` already carry `features.creatorShop` to the spoke via the hub session,
  or do we need a flag-read path in the spoke? (Determines how the gate + nav hide work.)
- **CF image upload:** is there an existing direct-upload endpoint the spoke can call for the CF-Images flow, or do we
  add one? (Blocks the submit form.)
- **Preview scope:** rebuild an in-Studio storefront preview, or link out to the existing public shop? (Recommend link-out
  for v1 to avoid porting the whole storefront render.)
- **Resell gallery:** kysely in-spoke vs. a read endpoint (the main app's `getPublicShopItems` has cursor pagination +
  filters worth reusing).
