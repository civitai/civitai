# ModelCard multi-baseModel badge — design

Date: 2026-06-29
Branch: `fix/search-base-model-non-primary-versions` (extends PR #2811)
Ticket: Freshdesk #68314 · ClickUp 868k4y3zy

## Problem

PR #2811 made the models search base-model filter match **non-primary** versions
(`version.baseModel` → array `versions.baseModel`). Side effect: a model can now
appear under a filter (e.g. SD 1.5) while its `ModelTypeBadge` still shows the
**primary** version's base (e.g. Pony). The badge misleads — it reads "Pony" but
the card matched because a non-primary version is SD 1.5.

Want: a badge that (a) indicates a model has versions across multiple base models,
and (b) under an active filter, leads with the **matched** base so the badge reads
as "why this card matched".

## Where the bug and data live (verified)

- **Search page (`/search/models`)** — bug is here. Badge renders primary
  `data.version.baseModel` regardless of filter. The card **does** carry the full
  `data.versions[].baseModel` array at runtime (search hit spreads `...item`;
  index emits both `version` singular and `versions` plural — `models.search-index.ts`
  transformData). The TS type omits `versions` (page passes `data={items as any}`).
  Index only includes Published + searchable versions.
- **Feed (`/models`)** — no bug. Server filters each model's versions to the active
  base model then `slice(0, 1)` (`model.service.ts:951-953, 981`) and emits only
  singular `version`, so the feed already shows the matched version. But it carries
  **no `versions[]` array**. The full per-version `baseModel` list IS already loaded
  in `dataForModelsCache` (`caches.ts:415-420`) before the slice, so surfacing a
  distinct list is cheap (no extra query).

## Active-filter sources (verified)

- Search: InstantSearch refinement on attribute `versions.baseModel`
  (`useInstantSearch().uiState[MODELS_SEARCH_INDEX].refinementList['versions.baseModel']`
  or `useRefinementList`). Page already calls `useInstantSearch`.
- Feed: Zustand `useModelFilters().baseModels` (string array); `ModelsInfinite.tsx`
  already reads `filters?.baseModels`.

## Scope decision

**Search + feed (full).** Badge behaves consistently in both contexts, filtered or
not. Requires one cheap server change (feed emits distinct base-model list).

## Components

### 1. `ModelTypeBadge` (presentational) — `src/components/Model/ModelTypeBadge/ModelTypeBadge.tsx`

- New optional prop `baseModels?: BaseModel[]` (ordered, matched-first). Keep
  existing `baseModel: BaseModel` for back-compat (other callers untouched).
- Render:
  - 0–1 distinct indicator codes → current single-indicator behavior, no tooltip.
  - 2+ distinct codes → map each base to its short code via existing
    `BaseModelIndicator`, **dedup by code** (SD 1.4 + SD 1.5 → one `SD1`), show the
    first **3** codes inline + `+N` for the remainder. Leading divider between model
    type and indicators unchanged.
  - Tooltip on the indicator group = full distinct base-model **names**, comma-joined
    (e.g. `Pony, SD 1.5, Illustrious, Flux.1 D`), in the same order. Covers the
    overflow tail and the hover affordance.
- Matched emphasis: lead-only (matched code is first). No extra color/bold in v1.

### 2. Pure helper `getCardBaseModels(data, activeBaseModels)` — unit-tested

- Lives next to ModelCard (e.g. `src/components/Cards/model-card.utils.ts`), no React.
- Resolve full list: `data.baseModels ?? data.versions?.map(v => v.baseModel) ?? [data.version.baseModel]`.
- Dedup preserving version-index order (the index/cache arrays are already ordered by
  `mv.index`).
- Matched-first: stably float any base whose value is in `activeBaseModels` to the
  front; preserve relative order otherwise.
- Returns the ordered distinct `BaseModel[]`.

### 3. `ModelCardContext` — `src/components/Cards/ModelCardContext.tsx`

- Extend `Context` type with `activeBaseModels?: string[]`.
- `useModelCardContext()` already returns `{}` when no provider — safe default.

### 4. `ModelCard` — `src/components/Cards/ModelCard.tsx`

- Read `activeBaseModels` from `useModelCardContext()`.
- `const baseModels = getCardBaseModels(data, activeBaseModels)`.
- Pass `baseModels={baseModels}` to `ModelTypeBadge` (keep `baseModel={data.version.baseModel}`
  as the single-mode fallback).

### 5. Filter wiring

- **Search** (`src/pages/search/models.tsx`): wrap the results grid in
  `ModelCardContextProvider value={{ activeBaseModels }}`, where `activeBaseModels`
  is read from the current `versions.baseModel` refinement. ModelCard never imports
  InstantSearch hooks, so the feed (no InstantSearch provider) stays safe.
- **Feed** (`src/components/Model/Infinite/ModelsInfinite.tsx`): provider already
  mounted — add `activeBaseModels: filters?.baseModels` to its value.

### 6. Server (feed only) — `getModelsRaw` in `src/server/services/model.service.ts`

- Before the existing `baseModels` filter / `slice(0, 1)`, compute
  `baseModels = [...new Set(allVersions.map(v => v.baseModel))]` from the full cached
  versions list and include it on the returned feed item. No extra query.
- Feed item type gains `baseModels: BaseModel[]` automatically; `UseQueryModelReturn`
  picks it up.

### 7. Types

- Extend the ModelCard data type with optional `baseModels?: BaseModel[]` and
  `versions?: { baseModel: BaseModel }[]` so the search-runtime field is typed and the
  feed field is consumed without `as any` for this field.

## Degradation / back-compat

- Single-base models render identically to today in all contexts.
- Other `ModelTypeBadge` callers (model detail page, etc.) pass only `baseModel` →
  unchanged.
- NSFW-restriction guard filter (`models.tsx:60`) stays on primary `version.baseModel`
  — out of scope.

## Testing

- Vitest on `getCardBaseModels`: dedup by base; matched-first ordering; each data
  source (`baseModels`, `versions`, singular `version` fallback); single-base no-op;
  empty `activeBaseModels`.
- Ladle story / component-preview for `ModelTypeBadge`: single, multi (no filter),
  multi matched-first, overflow `+N`, dedup-by-code.

## Out of scope

- Model detail page badge.
- Surfacing per-version base models anywhere beyond the distinct list needed here.
- Changing the NSFW-restriction guard semantics.
