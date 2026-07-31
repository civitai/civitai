# Generation Resource Picker

The `model.getResourceSelect` endpoint behind the generation form's Add model / Swap modal, and the operational work its known defects depend on.

## Overview

The picker modal (Checkpoint variant and the multi-type LoRA/LoCon/DoRA/TextualInversion variant) is locked to one ecosystem base model, paginates by Meili offset, and lets the user pick a version per card. Search moved server-side in `d6f5f1b17c`; before that the browser queried Meilisearch directly.

Two defects were measured against `civitai.red` on 2026-07-31 with read-only GETs:

**Failures render as a false empty state.** The endpoint intermittently returns `503 SERVICE_UNAVAILABLE` after a 10.2 s Meili timeout. One probe run got 4 of 6 default opens as 503 at 6.257 / 10.268 / 10.340 / 10.258 s; a later run of 8 got 8 × 200 at 0.38–0.91 s. The distribution is bimodal and intermittent. `ResourceHitList.tsx` has no error branch, so a 503 renders "No models found. We have a bunch of models, but it looks like we couldn't find any matching your query." — a confident claim that the catalogue is empty.

It is self-amplifying. `InViewLoader` awaits `fetchNextPage`, which *resolves* on error (React Query swallows the rejection unless a per-call `throwOnError` is passed). The failed page never lands in `state.data`, `hasNextPage` stays true, the sentinel stays in view, and the loader re-fires roughly every 500 ms forever. One parked user holds a `resourceSelect` limiter slot ~93 % of the time, on the one backend that deliberately bypasses the circuit breaker.

**The payload is ~4× larger than what renders.** 1,562,693 B uncompressed / 367,783 B brotli per 50-item page. `versions` 43.5 %, `images` 38 %. 753 versions ship and 87 survive the client's own `filterVersions`; 837 image objects ship and ~31 covers render.

Ruled out, to save the next investigation: superjson serialize is 34.78 ms, not seconds. Client-side cost after the bytes land is ~19.3 ms total. Offset pagination is stable (cursors 0/10/20 fetched twice — 31 items, zero duplicates, identical order). **Latency tracks filter shape, not payload size**: 7,713 wire bytes at 0.976 s TTFB versus 115,841 wire bytes at 0.449 s. So payload trimming is a CPU and egress win, not the fix for the 503s.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/services/resource-select.service.ts` | `getResourceSelectModels`, `buildFilter`, `meiliSortFor`, the official-model pin |
| `src/server/routers/model.router.ts` | The `getResourceSelect` procedure (~line 196) |
| `src/server/schema/model.schema.ts` | `getResourceSelectSchema` (~line 403) |
| `src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx` | Grid, `filterVersions`, the empty state that swallows errors |
| `.../ResourceSelectModal/ResourceSelectCard.tsx` | Card front face and the flip-only `ModelDetailsPanel` |
| `.../ResourceSelectModal/useResourceSelectInfinite.ts` | The infinite query; page size |
| `src/components/HiddenPreferences/useApplyHiddenPreferences.ts` | `case 'models'` — decides whether a card exists at all |
| `src/server/search-index/models.search-index.ts` | Index settings, `transformData`, `getModelSearchIndexRecords` |
| `src/server/meilisearch/client.ts` | `withMeiliResourceSelect`, limiters, circuit breaker |
| `src/server/utils/model-getall-images.ts` | `selectSlimGetAllModelImages` — the coverage-complete image cap to reuse |

## Maintainer / ops work

These need cluster or index access and cannot land as code changes from a PR.

### 1. Alert on a metric that already exists

`meili_call_timeouts_total{backend="resourceSelect"}` was added by `e8c2d9caa9` for exactly this purpose and has **no alert**. The probe runs above would have put 4 increments on it. Also worth a panel:

- `meili_call_duration_seconds{backend="resourceSelect"}` — the 0.4 s / 10.2 s bimodality is visible directly.
- `meili_call_queue_depth{backend="resourceSelect"}` and `meili_call_active{...}` — whether the 500-slot limiter is filling. Sampled lazily on scrape, so no hot-path cost.

Cheapest item on this page by an order of magnitude: it is a dashboard, and it answers whether any later fix worked.

### 2. Tune two env values (ConfigMap, no redeploy)

| Variable | Current | Suggested |
|---|---|---|
| `MEILI_RESOURCE_SELECT_TIMEOUT_MS` | `10_000` | ~3,000–4,000 |
| `MEILI_RESOURCE_SELECT_CONCURRENCY` | `500` | ~50 |

A 10 s budget on a modal the user opened 400 ms ago is 10 s past the abandon threshold — full Meili CPU spent for someone who already closed the dialog. Defaults are in `src/env/server-schema.ts`.

**Sequence this after the client error branch ships.** Without an error state, a faster timeout only produces the false empty state sooner.

### 3. Decide on Axiom visibility for this procedure

`src/pages/api/trpc/[trpc].ts` excludes `SERVICE_UNAVAILABLE` from ingest, deliberately — a 503 wave would self-amplify the ingest, and the reasoning is documented at the call site. The consequence is that the picker's dominant failure mode produces **no log line at all**; only the Prometheus counter sees it. Either carve out this procedure or accept the counter as the sole signal. This is a maintainer call, not a code fix.

### 4. Schedule a full models reindex

Two separate things need one, and the index is already drifted.

**The drift.** `sortMetrics` and `isOfficial` are returned to clients on all 50 Meili hits despite being absent from `displayedAttributes`. `onIndexSetup` runs **only** from the full-rebuild swap path in `base.search-index.ts`; the incremental call is commented out. So the Creator Controls guarantee documented in `models.search-index.ts` — "a masked model's real count is never returned to any client" — is currently false for every consumer of this index, public search included. A per-request `attributesToRetrieve` on the picker closes it on that one path only.

**The structural fix.** A denormalized, filterable `generatableBaseModels: string[]` (base models that have at least one *generatable* version) collapses three predicate owners into one.

Today the picker's real predicate is *does this model have a version that is both `canGenerate` and in this ecosystem* — an existential over children. It is evaluated independently by three parties, none authoritative:

1. `buildFilter` asserts `canGenerate = true` (a **model-level rollup**) and `versions.baseModel IN [...]` (matches **any** version) as independent conditions, so it matches a model whose generatable version and whose ecosystem version are *different versions*. Per-version `canGenerate` exists in the document but is not in `filterableAttributes`, so Meili cannot be asked the right question.
2. `filterVersions` re-derives the conjunction correctly, in the browser, after the bytes have shipped.
3. `useApplyHiddenPreferences` independently drops a model whose images all fail the browsing level, and excludes that bucket from the `hiddenCount` shown to the user.

Measured: 4 of 51 checkpoint items rendered nothing, 3 of them for reason 1 exactly. Because the superset filter runs before pagination and the subset filters after, this also produces short non-monotonic pages and `nextCursor` values that promise more than they deliver.

**Cost, stated plainly:** reading every published model in 2000-row batches with `modelSearchIndexSelect`, rebuilding `models_NEW`, swapping, clearing the update queue. Hours of DB read load, double index storage during the build, and a window where a swap failure leaves a stale index. Needs a named owner and a rollback plan. No SQL is involved, so the applied-by-hand migration rule does not literally apply, but it is the same class of manual per-environment operation and deserves the same explicit surfacing.

### 5. Filter shape — the actual 503 fix, and a product decision

`buildFilter` emits three bitmap negations (`availability != Private`, `NOT id IN [officialIds]`, `NOT tags.name = "celebrity"`), and an empty query forces the `metrics.thumbsUpCount:desc` ranking rule to order the whole match set. Each negation is a complement over the full model universe.

Turning `availability != Private` into a positive `IN` and getting the celebrity-tag complement off the hot path are both plausible wins, but both change *what the picker returns*. That is a product call plus a benchmark, not a refactor, so no PR in the current sequence touches it. Note also that `nsfwLevel` is already filterable and `buildFilter` never uses it — moving the browsing-level predicate server-side would both shrink the match set the ranking rule sorts and cut the image payload.

## Notes for whoever picks this up

The recurring theme is that nothing in this modal has ever been allowed to fail out loud:

- `ResourceHitList` has no error branch.
- `handleSelect` in `ResourceSelectCard` awaits `fetchGenerationData` with no `.catch`, so `setLoading(false)` never runs on failure and the Select button spins forever.
- `InViewLoader` swallows rejections by way of React Query.
- `SERVICE_UNAVAILABLE` is excluded from Axiom.

That is why a 10.2 s Meilisearch timeout has been rendering as "we couldn't find any matching your query". Fixing the error branches is worth more than any of the payload optimisations.

`e8c2d9caa9` ("stop the resource picker returning an empty list") opens its own commit message with this observation and fixed the two upstream causes without acting on it. It is still true.
