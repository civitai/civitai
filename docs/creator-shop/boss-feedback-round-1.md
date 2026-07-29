# Creator Shop — Boss Feedback Round 1

Transcribed and organized from a verbal review. Grouped by area, deduplicated, with
checkboxes. `@ai:` notes flag decisions/questions. Priority: **P1** foundational/blocking,
**P2** important polish, **P3** nice-to-have / later.

---

## A. Storefront (profile `/user/[username]/shop` — `shop.tsx`, `StorefrontSections.tsx`, `ShopItemGrid.tsx`)

- [x] **A1 (P1)** Wrap the shop page in the same **container/max-width** the other profile tabs use. → `shop.tsx` now uses `MasonryProvider` + `MasonryContainer` like the models tab.
- [x] **A2 (P1)** Rework the **shop header** overview-style → ringed `ThemeIcon` + larger `Title` + small clamped description (`ShopHeader.tsx`).
- [x] **A3 (P2)** Description capped at **300 chars** with a live counter in the settings modal; the header clamps display to 2 lines.
- [x] **A4 (P1)** **Section headers**: dropped the colored line + subtext; new shared `SectionHeader` = ringed icon + title. Icons come from a shared `section-meta.ts` map (also consumed by settings). `SectionAccent` deleted.
- [x] **A5 (P1)** **Card sizing** — resolved by the A1 container (max-width bounds the grid).
- [x] **A6 (P1)** **Featured section** — dropped the bordered/padded `Paper`; kept the gold header band standalone, grid now edge-to-edge (`FeaturedSection.tsx`).
- [x] **A7 (P2)** **Filters** — `ShopFiltersDropdown` gained `availableTypes`; Cosmetics passes the sellable set (Badge, Avatar Frame, Profile Background). `/shop` unaffected.
- [x] **A8 (P2)** **Modifiers** — `ShopFiltersDropdown` gained `hideModifiers`; Cosmetics hides Owned/Not-owned.
- [x] **A9 (P2)** **Sort UI** — Cosmetics now uses `SelectMenuV2` (same control as the images/models feed) instead of a custom `Select`.
- [~] **A10 (P2)** **Filter/sort position** — kept per-section but moved onto the section header line (the position the boss ultimately accepted). Not hoisted to the shop-name row; revisit if he wants it at the very top.

## B. Mod access (P1)

- [x] **B1 (P1)** Mods can now see the shop tab and manage any shop. `ProfileNavigation` shows the tab for moderators regardless of publish state; `ShopHeader` shows a Manage button (`canManage`); the manage page lets mods through the access gate, resolves the target creator's `userId`, skips the owner-only Creator-Program eligibility gate, and threads the target `userId` into `getManageItems`/`getSettings`/`updateSettings` (all honored for moderators server-side). Settings + feature-picker modals accept a `targetUserId`. Add-item buttons are hidden for a mod on someone else's shop (they manage, not add).

## C. Profile overview integration (P2)

- [x] **C1 (P2)** New `shop` profile-section type (`ProfileSectionTypeDef` + registry in `profile.utils`). `ShopSection` renders the creator's featured items with a "Visit shop" action; off by default, and shows nothing unless the shop is published with featured items. Users enable/place it via the profile editor.

## D. Profile editor / customize profile (P2)

- [x] **D1 (P2)** Drag handle changed from `IconArrowsMove` (4-way) to `IconArrowsMoveVertical`.
- [x] **D2 (P2)** Added an inline `restrictToVerticalAxis` dnd modifier (no new dependency) so sections only reorder vertically.

## E. Publish gating (P1)

- [x] **E1 (P1)** `updateCreatorShopSettings` now rejects enabling a shop with zero items (`throwBadRequestError`, checked inside the txn). Client-side, the manage-page draft banner disables the Publish button with an explanatory tooltip when the shop has no items.

## F. Shop settings sections (P2)

- [x] **F1 (P2)** Settings sections are now drag-to-reorder (dnd-kit + `SortableItem`, vertical-axis locked), matching the profile customize UI — replaced the up/down arrows.
- [x] **F2 (P2)** Removed the per-section icons from the settings rows (they live on the page section headers via `section-meta`); rows now show a drag handle + label + visibility switch.

## G. Submit-item modal (`CreatorShopSubmitModal.tsx`, `useSubmitCreatorShopForm.ts`)

- [x] **G1 (P2)** Submit button is now the shared `BuzzTransactionButton` (`accountTypes={[buzzType]}`) — buzz-colored, shows the fee as a currency badge, and opens the buy-Buzz modal if short. Buzz-type is picked in the FeeSection segmented control (the "dropdown on the button" nicety left for later).
- [x] **G2 (P2)** Fee callout is now **yellow** (was blue) when affordable.
- [x] **G3 (P2)** **"Non-refundable"** is bold.
- [x] **G4 (P2)** Cancel is left-aligned (footer is `justify="space-between"`).
- [x] **G5 (P2)** Cancel triggers a `ConfirmDialog` when the form is dirty (art uploaded / info entered / edits made).
- [x] **G6 (P2)** Price label is now **"Sell price"**.

## H. Manage list (`ManageHeader.tsx`, manage item list/table)

- [x] **H1 (P2)** Item-list thumbnail uses `CosmeticThumb bare` — no background/border.
- [x] **H2 (P2)** Status column widened (140→170) + badge `maxWidth: none` so "Pending review" isn't truncated.
- [x] **H3 (P2)** Edit "Save changes" is a plain button with no bolt icon (only the submit-for-review button carries the fee).
- [x] **H4 (P2)** `ManageHeader` has a back arrow (top-left) → the storefront.

## I. Review queue (`moderator/creator-shop.tsx`)

- [x] **I1 (P2)** Dropped the bare price element from the left list row.
- [x] **I2 (P2)** Left-list thumb uses `CosmeticThumb bare` — no box border/background.
- [x] **I3 (P2)** "Submitted by" is now an `Anchor` → creator profile, opens in a new tab.
- [x] **I4 (P2)** Preview sidebar widened (340→420) and artwork box enlarged (280→320).
- [x] **I5 (P2)** Description replaced with a labeled **Details** table (cosmetic name + description).
- [x] **I6 (P2)** `CosmeticPreview` gained `hideHeader`; the review page passes it (drops the duplicate centered "Preview"), and the "In-context preview" label is sized like "Flag concerns".
- [x] **I7 (P2)** Flag buttons now toggle their label in/out of the note, light up (filled + check) while active, and can't double-add.
- [x] **I8 (P2)** Status `Select` has an `IconFilter` leftSection.
- [x] **I9 (P1)** Backend already stored `RequestedChanges` distinctly from `Rejected` (+ `rejectionReason`); the gap was frontend — added a **"Changes requested"** filter option and status badges. (No note loss: it was the notes-not-loading bug, see I11.)
- [x] **I10 (P2)** Status badge shown next to the type badge in the review header.
- [x] **I11 (P1)** Selecting an item now seeds the note field from its saved `rejectionReason` (loads existing notes).
- [x] **I12 (P2)** "All statuses" now returns every status except Archived (service: no status filter instead of defaulting to Pending); left list shows a status badge when the "All" filter is active.
- [x] **I13 (P2)** Left list now infinite-loads via `InViewLoader` + `fetchNextPage`.
- [ ] **I14 (P3)** Ability to **sort** the review list — later.

---

## Suggested execution order

1. **Storefront foundation** — A1, A5, A2, A4, A6 (container + header + section headers + featured wrapper; highest visibility, interrelated).
2. **Storefront filters/sort** — A7, A8, A9, A10.
3. **Mod access + publish gating** — B1, E1 (correctness).
4. **Review queue correctness** — I9, I11, I12, I10, I13 (status model + notes; data-integrity).
5. **Review queue polish** — I1, I2, I3, I4, I5, I6, I7, I8.
6. **Submit modal** — G1–G6.
7. **Manage list** — H1–H4.
8. **Profile integration + editor** — C1, D1, D2, F1, F2.
