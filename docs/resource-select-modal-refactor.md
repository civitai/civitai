# Resource Select Modal — refactor proposal

Status: proposal / in progress
Owner: (unassigned)
Scope: `src/components/ImageGeneration/GenerationForm/ResourceSelectModal/**` + `ResourceSelectFilters.tsx`, `resource-select.types.ts`, `useResourceSelectFilters.ts`

## Problem

The generator's resource picker (`ResourceSelectModal`) is hard to reason about and fragile to change. The root cause is that **one InstantSearch instance is made to serve three unrelated concerns**:

1. **Full-text / faceted search** — the `all` and `official` tabs, plus the search box and type/base-model facets. This is what InstantSearch is actually for.
2. **Curated / personalized ID lists** — `recent`, `liked`, `featured`, `recommended`, `auction`. These are fetched up front via tRPC, then their ids are injected back into the Meili query as `id IN [...]` so InstantSearch just paginates a pre-computed set.
3. **Generation eligibility / version resolution** — client-side filtering of model versions by `canGenerate` / base-model, hidden-preference filtering, and the featured "podium" re-ordering.

Because all three run through the same pipe, the seams leak into a pile of workarounds.

## Concrete smells (evidence)

- **Sort is expressed as index-name magic.** Official-first ordering is a Meili replica (`models_v9:isOfficial:desc`) selected by mutating `indexUiState.sortBy` in an effect (`ResourceSelectModalContent.tsx`), with two `'Relevance'` keys in `resourceSort` — one hidden from the dropdown in `ResourceSelectFilters.tsx`, and a label lookup that must cover both. This produced the "index not in `items` of `sortBy`" warning, the `Attribute isOfficial is not sortable` hard-fail, and a tab-switch race. Conditional sorting fights InstantSearch's index-per-sort model.
- **The Meili filter is a hand-concatenated string.** `useResourceSelectMeiliFilters` (~150 lines) assembles AND/OR clauses, `id IN [...]`, manual quote-escaping, and base-model relaxation. No escaping guarantees, precedence is by hand-placed parentheses, and it is effectively untestable.
- **Two data paradigms behind one UI.** `all`/`official`/`mine` are real Meili queries; `recent`/`liked`/`featured`/`recommended`/`auction` prefetch ids via tRPC (`useResourceSelectQueries`) and feed them back as `id IN [...]`. InstantSearch is a search engine for some tabs and a dumb paginator for others.
- **Meili output is overridden on the client.** `ResourceHitList` re-sorts featured by auction `position`, splits a podium, filters versions (`filterVersions`, duplicating the Meili base-model logic via `skipBaseModelForOwnTabs` — a comment literally says "keep them in sync"), and applies hidden preferences. So the displayed order/content diverges from what Meili returned.
- **Pagination defeated for featured.** `hitsPerPage={selectedTab === 'featured' ? 1000 : hitsPerPage}` loads "everything" into one page so the client position-sort works.
- **State scattered + remount hacks.** Tab lives in `localStorage`; sort in InstantSearch UI state; list ids in tRPC caches; facets in `<Configure>`. `key={totalFilters}` on `<Configure>` and `key={selectedTab}` on `ResourceHitList` force remounts instead of managing state.

## Proposed direction (phased)

Do **not** rewrite in one pass. Land the low-risk wins first, re-measure, then decide on the structural step.

### Phase 1 — quick wins (low risk, no behavior change)

- [x] **Typed Meili filter builder.** Replace string concatenation in `useResourceSelectMeiliFilters` with a small composable `and()/or()/eq()/ne()/inArray()/not()` module that handles quoting/escaping. Pure refactor + unit-testable. → `src/components/Search/utils/meili-filter.ts`
- [x] **Consolidate the sort.** Extract the tab→sort `indexUiState` nudge into a single `useResourceSortForTab(tab)` hook co-located with the sort constants, instead of the logic living across `index.tsx`, `resource-select.types.ts`, `ResourceSelectFilters.tsx`, and `ResourceSelectModalContent.tsx`.

### Phase 2 — separate the concerns (medium)

- [ ] **Split "curated list" tabs off InstantSearch.** Render `recent`/`liked`/`featured`/`recommended`/`auction` directly from their tRPC data into the shared card grid; use InstantSearch **only** for the true search tabs (`all`/`official` + query/facets). Removes the `id IN [...]` injection, the `hitsPerPage=1000` hack, and lets the featured podium be an honest curated list.
- [ ] **De-duplicate version eligibility.** Move `filterVersions` / base-model relaxation into one shared util (or server-side) so the Meili filter and the client filter can't drift.
- [ ] **Remove the `key={...}` remounts** once the data sources are separated and no longer need forced resets.

### Phase 3 — one server contract (bigger, optional)

- [ ] `resource.pickerSearch({ query, tab, types, baseModels })` returning an already-ordered, already-eligibility-filtered page (Meili server-side for search tabs, Postgres/caches for curated tabs). The client renders + paginates only. Collapses all three concerns; deletes filter-string building, id-IN injection, client re-sort, dual sort keys, and version dedup.

## Non-goals / risks

- Not changing the visible tabs, card UI, or generation flow.
- Phase 2 introduces two rendering paths (search grid vs. curated grid); acceptable because each becomes simpler and honest about what it is.
- Phase 3 is a real project; only pursue if Phase 1–2 don't sufficiently reduce the pain.

## Progress log

- Phase 1 prototyped alongside this proposal (filter builder + `useResourceSortForTab`). See the diff on the same branch.
