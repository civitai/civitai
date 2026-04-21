# Browser Memory & Image-Size Audit

Context: the `feature/smaller-images` branch introduces `useCardImageWidth()` which returns 320 (flag on) or 450 (flag off), wired through `MasonryProvider` and many card/carousel components. Goal is to reduce bandwidth and client memory pressure on image-heavy feeds.

This document captures two things:

1. Components where the 320 request is likely **visibly stretched/blurry** because the display box is wider than 320 CSS px (or wider than 640 physical px at retina).
2. Other, non-image contributors to browser memory pressure worth addressing.

---

## Part 1 — Image stretching concerns (450 → 320)

### Highest concern — carousel/hero displays

These render at widths well over 320 but now fetch at 320.

- [ModelCarousel.tsx:132](../../src/components/Model/ModelCarousel/ModelCarousel.tsx#L132) — already flagged by the user. Carousel slides can occupy most of the content column on desktop.
- [ResourceReviewCarousel.tsx:92](../../src/components/ResourceReview/ResourceReviewCarousel.tsx#L92) — Embla slides are `flex-[0_0_50%]` on `md+`, routinely 400–600 px wide.
- [Bounty/ImageCarousel.tsx:123](../../src/components/Bounty/ImageCarousel.tsx#L123) — same carousel pattern as ModelCarousel.
- [SimpleImageCarousel.tsx](../../src/components/SimpleImageCarousel/SimpleImageCarousel.tsx) — not yet migrated, but worth validating before it is.

### Strong concern — fixed boxes larger than 320

- [PurchasableRewards.tsx:134, :270, :361](../../src/components/PurchasableRewards/PurchasableRewards.tsx#L134) — reward image container sizes come from `constants.purchasableRewards.coverImageWidth` which is **850** or **1600** in [constants.ts:217, 235, 239](../../src/server/common/constants.ts#L217). Fetching 320 into an 850/1600 slot is a large upscale.
- [CardDecorationModal.tsx (PreviewCard) :206-209, :218](../../src/components/Modals/CardDecorationModal.tsx#L206) — preview card height tied to `constants.cardSizes.image`; wide aspect-ratio images cap at `cardImageWidth * aspect` = 320 * aspect.
- [Challenge/WinnerPodiumCard.tsx:160, :166-167](../../src/components/Challenge/WinnerPodiumCard.tsx#L160) — first-place podium is `w-80` (320 CSS px) → needs 640 physical px at 2x DPR; also used as MediaHash height on portrait images (squats them).

### Moderate concern — feed cards at retina / single-column

- [ImagesAsPostsCard.tsx:296, :387](../../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L296) — single-image posts render at full column width.
- [MasonryProvider.tsx:47](../../src/components/MasonryColumns/MasonryProvider.tsx#L47) + [MasonryColumns.tsx:58](../../src/components/MasonryColumns/MasonryColumns.tsx#L58) + [MasonryColumnsVirtual.tsx:64](../../src/components/MasonryColumns/MasonryColumnsVirtual.tsx#L64) — systemic. In single-column (mobile), card width equals `cardImageWidth` = 320 CSS px, which is 640 physical px at 2x DPR. All card stretching issues descend from this.
- [Challenge/ChallengeSelectableImageCard.tsx:93](../../src/components/Challenge/ChallengeSelectableImageCard.tsx#L93), [NewOrderRatingGuideModal.tsx:130](../../src/components/Games/NewOrder/NewOrderRatingGuideModal.tsx#L130), [JudgmentHistory.tsx:153](../../src/components/Games/NewOrder/JudgmentHistory.tsx#L153) — modal review/selection surfaces, can be wider than 320 on desktop.

### Worth spot-checking

- [Model/Categories/ModelCategoryCard.tsx:374](../../src/components/Model/Categories/ModelCategoryCard.tsx#L374)
- [Model/CollectionShowcase/CollectionShowcase.tsx:140](../../src/components/Model/CollectionShowcase/CollectionShowcase.tsx#L140)
- [Comics/PanelCard.tsx:261](../../src/components/Comics/PanelCard.tsx#L261), [pages/user/[username]/comics.tsx:218](../../src/pages/user/[username]/comics.tsx#L218)
- [ResourceHitList.tsx:235](../../src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx#L235)
- [pages-old/clubs/[id]/index.tsx:269](../../src/pages-old/clubs/[id]/index.tsx#L269), [pages-old/clubs/manage/[id]/index.tsx:232](../../src/pages-old/clubs/manage/[id]/index.tsx#L232)
- [moderator/cosmetic-store/sections/index.tsx:193](../../src/pages/moderator/cosmetic-store/sections/index.tsx#L193)

### Systemic note — device pixel ratio

`useCardImageWidth()` returns CSS pixels. On a 2× DPR screen, a card displayed at 320 CSS px needs **640 source px** to be crisp; the old 450 request was already short. Consider returning `baseWidth * clamp(window.devicePixelRatio, 1, 2)` (or similar) rather than a fixed CSS-pixel value, so retina users don't pay a perceptible quality hit. Alternatively, keep 320 only where the display box is definitely ≤ 320 CSS px and use a separate larger constant for carousel/hero surfaces.

---

## Part 2 — Other browser memory contributors

Prioritized by likely real-world impact on image-feed sessions.

### High severity

- **React Query cache has no GC** — [utils/trpc.ts:69-77](../../src/utils/trpc.ts#L69). `QueryClient` is configured with `staleTime: Infinity` and no explicit `gcTime`. All infinite-query pages (feeds, comics, challenges, reviews) persist in cache for the entire session. Combined with `keepPreviousData: true` in feeds (e.g. [ImagesAsPostsInfinite.tsx:105](../../src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx#L105)), a long scroll accumulates every page ever fetched. Consider setting a `gcTime` (e.g. 10 min) and a `maxPages` on infinite queries.
- **Module-scope unbounded resource cache** — [store/resource-data.store.ts:65-71](../../src/store/resource-data.store.ts#L65). `resourceFetchByIds: Map<number, Promise<void>>` and `resourceNotFoundIds: Set<number>` grow for the lifetime of the tab; nothing evicts them.
- **Module-scope generation-graph promise cache** — [store/generation-graph.store.ts:145](../../src/store/generation-graph.store.ts#L145). `Map<string, Promise<GenerationData>>`; each entry is a full generation payload (resources + params). Never purged.
- **Hidden-preferences flatMap on every render** — [hooks/useApplyHiddenPreferences.ts:43, 53-92](../../src/components/HiddenPreferences/useApplyHiddenPreferences.ts#L43). Every infinite-scrolled feed flatmaps+filters the entire page array on every render cycle, allocating large intermediate arrays. With a 10-page feed × 20-50 items/page this is a recurring alloc/GC pressure source.

### Medium severity

- **TrackPageView visibility ref grows unbounded** — [TrackView/TrackPageView.tsx:10, :51](../../src/components/TrackView/TrackPageView.tsx#L51). Appends to a `useRef` array on every visibility change; no cap or cleanup.
- **source-metadata-store persists 50× in sessionStorage** — [store/source-metadata.store.ts:16, :74-94](../../src/store/source-metadata.store.ts#L16). Keyed by image URL; no dedupe across edits.
- **Feed `data.pages.flatMap(...)` without memo** — multiple feeds repeat this pattern (e.g. `image.utils.ts:157-158`, `ComicsInfinite.tsx:49`, comments providers). Usually re-computes on every render.
- **IntersectionObserver per video instance** — [EdgeMedia/EdgeVideoBase.tsx:31-47](../../src/components/EdgeMedia/EdgeVideoBase.tsx#L31). One observer per video element; only cleaned up on unmount. Videos kept in DOM (carousels, modals) keep observers alive.

### Low severity

- **metric-signals store unbounded deltas** — [store/metric-signals.store.ts:24-35](../../src/store/metric-signals.store.ts#L24). Accumulates `entityType:id:metricType` keys without TTL.
- **Per-image zustand store grows with feed** — [store/image.store.ts:14-26](../../src/store/image.store.ts#L14). One key per image ID; never evicted.

### Suggested sequence

1. Set `gcTime` on the global QueryClient and `maxPages` on feed infinite queries — likely the single largest win.
2. Bound the two module-scope caches (resource-data, generation-graph) with an LRU or session-scoped clear.
3. Memoize the hidden-preferences filter pipeline.
4. Revisit the 320 CSS-pixel vs. DPR question so the image-size reduction doesn't land as user-visible blur.
