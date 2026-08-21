# Image Queue Unification — Plan

## Motivation

The spoke now has ~10 image-grid moderation surfaces. They visibly share a card grid, a
browsing-level filter, and cursor pagination — but that shared shape is implemented in two
incompatible ways, so we keep re-writing it. This plan separates the two *kinds* of unification
available and scopes each to where it actually pays off.

## Survey (what's actually shared vs. divergent)

| Page | URL | Role | Grid | Actions | Read-only? |
|---|---|---|---|---|---|
| Review modes | `/images/[slug]` | staff | `ImageReviewGrid` | — | yes (mutations pending) |
| Reported | `/images/reported` | staff | `ImageReviewGrid` | — | yes |
| Appeals | `/images/appeals` | **senior** | `ImageReviewGrid` | — | yes |
| CSAM | `/images/csam` | **senior** | `ImageReviewGrid` | — | yes |
| Image Tags | `/image-tags` | staff | hand-rolled | `moderate` | no |
| Image Ratings | `/image-rating-review` | staff | hand-rolled | `setLevel` | no |
| Downleveled | `/downleveled-review` | staff | hand-rolled | `setLevel` | no |
| Ingestion Errors | `/ingestion-error-review` | staff | hand-rolled | `resolve` | no |
| Images to Ingest | `/images/to-ingest` | staff | hand-rolled | — | yes |

Two clean groups fall out:

- **Review family** (rows 1–4): all use `ImageReviewGrid`, all read-only, one conceptual queue,
  all under the `/images` access parent. Differ only in query + per-card detail.
- **Action pages** (rows 5–9): each hand-rolls the *same* grid (`minmax(300px,1fr)`, `aspect-[4/5]`,
  `EdgeMedia width=450`, browsing-level chips) plus its own `SvelteMap` selection + `enhance` action
  form. Each is a distinct workflow with its own mutation and its own top-level URL.

## Two axes of unification — and where each applies

1. **Route-level discrimination** — one `[slug]` route, a `kind`-discriminated payload, per-view
   card branches. Cheap and clarifying *when views share query-family + item-shape + access parent
   and are read-mostly*. **Applies to the review family only.**
2. **Component-level sharing** — promote `ImageReviewGrid` to *the* image-queue grid so every page
   composes it instead of re-implementing it. Independent of routing. **This is the real DRY win,
   and it covers the action pages that a shared route never could.**

Route-folding the action pages is **out of scope** (overreach): they don't share a route, they
share a grid; merging them produces a god-route with five action sets and no code saved.

**A and B are not either/or — they're complementary and sequenced (A → B).** A consolidates the
review *routes*; B de-duplicates the *grid* across every page (incl. the ones A doesn't touch). B is
where the mutations for the review family will land, so A → B → review mutations is one throughline.

## Legacy action model (findings)

The legacy `/moderator/images.tsx` is a single tabbed page with a shared selection store and one
bulk-action toolbar. Two facts drive B's design:

- **Selection is per-tab, never cross-tab** — `useEffect(deselectAll, [viewType])` wipes the
  selection on every tab switch. So there is no cross-view selection to hoist; selection state can
  live at the page/grid level, scoped to one view.
- **The toolbar is shared UI but the action is view-aware** — `image.moderate` for the review tabs,
  `report.bulkUpdateStatus` for reported, a CSAM path for csam. So the reusable piece is a
  *bulk-action bar shell* (select-all / clear / count) into which each view injects its own action.

---

## Plan A — Review-family `[slug]` unification

Fold `reported` / `appeals` / `csam` into `/images/[slug]` alongside the six review modes.

1. **Gate** (`hooks.server.ts`): key `canAccess` on `event.url.pathname` instead of `event.route.id`
   (keep the `route.id &&` guard so static assets stay ungated). Verified against the real
   `canAccess`: per-slug roles resolve correctly, incl. `__data.json` data requests and sub-path
   endpoints (`/images/csam/__data.json` → senior, `/images/csam/verdict` → senior). This is the
   only change that lets a senior view live under `[slug]` without a privilege regression.
2. **Load**: validate slug against all image views (else 404); `switch` dispatches to the existing
   service per view; return a `kind`-discriminated payload:
   - `minor` / `remixSource` → `kind: 'review'` **+ `promptHighlight`**
   - `poi` / `tag` / `newUser` / `modRule` / `csam` → `kind: 'review'`
   - `reported` → `kind: 'reported'`
   - `appeals` → `kind: 'appeal'`
3. **Page**: discriminate on `kind`; each branch renders `ImageReviewGrid` with its card snippet
   (move the reported/appeal/csam detail markup in from their current pages).
4. **Delete** `/images/reported`, `/images/appeals`, `/images/csam` route dirs. `NAVIGATION`
   paths/roles are unchanged, so senior gating now flows from the nav roles via the pathname gate.

Scope: small. Item shapes already exist; the gate change is one line + re-verify.

## Plan B — Shared image-queue grid (the actual duplication) — DONE

**Correction from the survey:** the spoke's action pages don't use selection/bulk actions at all —
they went with **per-card immediate actions + optimistic dimming** (a `SvelteMap` of actioned ids that
dims the card, `invalidateAll:false`). So the legacy select-then-bulk toolbar isn't the shared need; a
selection/bulk-bar would have been speculative. The real duplicated primitive is the **image-card
shell + 300px grid + Next**, with a page-supplied card body.

Done:
1. Extracted `ImageQueueGrid.svelte` — the shared primitive: 300px auto-fill grid, `aspect-[4/5]` image
   card linking to the main app (`EdgeMedia w=450`), empty-state, cursor-paged Next (number *or* string
   cursor). Body via a `card` snippet; optional per-card `itemClass` for dimming; optional `keyOf`.
2. Rewrote `ImageReviewGrid` to compose it (public props unchanged, so `[slug]` is untouched) — it now
   only adds the title + browsing-level filter header and the user-header row.
3. Migrated the three pages whose card matches exactly: **image-tags**, **image-rating-review**,
   **downleveled-review** — hand-rolled grid/card/Next replaced by `ImageQueueGrid`; loads + actions
   untouched. Card grid now defined in one place.

**Deliberately NOT migrated** (would change UX for no real gain — the overreach line):
- `ingestion-error-review` — bespoke layout with **actions above the image** and no aspect box; a
  different grid (`auto-fit 300px`). Migrating would reshape its UX.
- `images/to-ingest` — a dense small-card **browse gallery** (`grid-cols-2..5`, metadata aspect,
  `object-cover`), read-only. Different purpose from the review card.

## Sequencing

1. ✅ Current batch (read foundation + unified nav + reported count + prompt-highlight) — `25ca66c4d5`.
2. ✅ **Plan A** — review-family `[slug]` unification + pathname gate — `c2444bfea6`.
3. ✅ **Plan B** — `ImageQueueGrid` primitive + migrate image-tags / image-rating-review /
   downleveled-review; ingestion-error + to-ingest left as intentionally-divergent.
4. **Next:** per-view **mutations** on the review family (still read-only) — approve/block/delete for
   the review modes, `bulkSetReportStatus` for reported, `resolveEntityAppeal` for appeals. These are
   per-card immediate actions (matching the action pages' pattern), rendered in the `[slug]` card
   snippets. `ImageQueueGrid` already supports the dimming (`itemClass`) they'll want.

## Open questions

- `@ai:` Plan A changes the global gate from `route.id` → `pathname`. It's verified for the image
  routes; do we want a quick pass over the *non-image* routes (all static, so `pathname === route.id`)
  to be safe, or trust the equivalence? *(recommend: a one-shot `canAccess` table over every
  NAVIGATION path before/after, asserting no diff for static routes.)*
- `@ai:` Plan B's selection/action affordances on `ImageReviewGrid` — build them speculatively now,
  or defer until the first action page is migrated so the API is driven by a real consumer?
  *(recommend: defer; migrate `image-tags` first and let it shape the API.)*
- ~~`@dev` cross-view bulk actions?~~ **Resolved** — the legacy page clears selection on every tab
  switch (`deselectAll` on `viewType`), so there is no cross-view selection. Selection stays per-view
  in the page that owns the grid. (Revisit only if a *new* cross-tab workflow is ever wanted.)
