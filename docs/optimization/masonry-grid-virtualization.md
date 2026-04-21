# MasonryGrid Virtualization Plan

## Motivation

Long-scrolling infinite feeds currently mount every card from every page in the DOM. With `staleTime: Infinity` on the React Query client and no `maxPages` cap, a user scrolling 10 pages of ~50 items keeps 500 cards mounted simultaneously. The browser pays for each one:

- ~1-2 KB of DOM + React fiber + computed-style overhead per node. Mantine components typically wrap in 3-5 divs per logical card.
- **Decoded image bitmap**, which is usually the dominant per-card cost. An image displayed at 320×450 at 2× DPR holds a ~1.1 MB decoded RGBA surface in memory while mounted (width × height × DPR² × 4 bytes). At 320×450 × 1 DPR that's still ~575 KB.

At 500 cards mounted, the decoded-bitmap footprint alone can be 200–500 MB regardless of how small each network payload is. Reducing image request widths (450→320) helps bandwidth and decode work but does not reduce this if elements stay mounted — unmounting off-screen cards does.

## Current state

There are **two layout families** in [src/components/MasonryColumns/](../../src/components/MasonryColumns/), with different virtualization stories:

### Column-based (variable-height cards) — already handled

- [MasonryColumns.tsx](../../src/components/MasonryColumns/MasonryColumns.tsx) — non-virtualized.
- [MasonryColumnsVirtual.tsx](../../src/components/MasonryColumns/MasonryColumnsVirtual.tsx) — tanstack-virtual-backed.

Used by image/post/as-posts feeds. The following call sites already use `MasonryColumnsVirtual`:

- [pages/search/images.tsx](../../src/pages/search/images.tsx)
- [components/Image/Infinite/ImagesInfinite.tsx](../../src/components/Image/Infinite/ImagesInfinite.tsx)
- [components/Image/AsPosts/ImagesAsPostsInfinite.tsx](../../src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx)
- [components/Post/Infinite/PostsInfinite.tsx](../../src/components/Post/Infinite/PostsInfinite.tsx)
- [components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx](../../src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx)

Several components delegate to these and are already covered — e.g. [UserMediaInfinite](../../src/components/Image/Infinite/UserMediaInfinite.tsx) renders `ImagesInfinite`.

Remaining non-virtual `MasonryColumns` usages are moderator/admin pages and out of scope here.

### Uniform-cell grid (square cards) — target of this work

- [MasonryGrid.tsx](../../src/components/MasonryColumns/MasonryGrid.tsx) — non-virtualized CSS grid; every card is `columnWidth` square.
- [UniformGrid.tsx](../../src/components/MasonryColumns/UniformGrid.tsx) — similar layout, finite-size (used by home blocks with `maxRows`).
- **No `MasonryGridVirtual` exists yet.**

The following 8 main card feeds use `MasonryGrid` and are not virtualized:

- [Model/Infinite/ModelsInfinite.tsx](../../src/components/Model/Infinite/ModelsInfinite.tsx) — main `/models` index; single largest opportunity.
- [Article/Infinite/ArticlesInfinite.tsx](../../src/components/Article/Infinite/ArticlesInfinite.tsx)
- [Collections/Infinite/CollectionsInfinite.tsx](../../src/components/Collections/Infinite/CollectionsInfinite.tsx)
- [Comics/ComicsInfinite.tsx](../../src/components/Comics/ComicsInfinite.tsx)
- [Bounty/Infinite/BountiesInfinite.tsx](../../src/components/Bounty/Infinite/BountiesInfinite.tsx)
- [Challenge/Infinite/ChallengesInfinite.tsx](../../src/components/Challenge/Infinite/ChallengesInfinite.tsx)
- [Club/Infinite/ClubsInfinite.tsx](../../src/components/Club/Infinite/ClubsInfinite.tsx)
- [Tool/ToolsInfinite.tsx](../../src/components/Tool/ToolsInfinite.tsx)

## Proposed component

Build `src/components/MasonryColumns/MasonryGridVirtual.tsx` as a drop-in replacement for `MasonryGrid`.

`MasonryColumnsVirtual` is not a drop-in for these feeds because it assumes variable-height items and takes `imageDimensions`/`adjustHeight` props. `MasonryGrid` cards are uniform (`height = columnWidth`), so the virtual version is actually simpler: a single `useVirtualizer` for rows, each virtual row rendering up to `columnCount` cards.

### API surface

Match `MasonryGrid` exactly so migration is a one-line import swap per feed:

```ts
type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  withAds?: boolean;
  overscan?: number; // new, optional — defaults to something sensible like 2
};
```

### Shape

```ts
const { columnCount, columnWidth, columnGap, rowGap } = useMasonryContext();
const rowCount = Math.ceil(items.length / columnCount);
const rowVirtualizer = useVirtualizer({
  count: rowCount,
  getScrollElement: () => scrollAreaRef?.current ?? null,
  estimateSize: () => columnWidth + rowGap,
  overscan,
  scrollMargin,
});

// each virtual row slices items[row * colCount, (row + 1) * colCount)
// into a flex/grid row of columnCount cards
```

Key considerations:

- **Scroll container**: use `useScrollAreaRef()` the same way `MasonryColumnsVirtual` does. The measured `scrollMargin` via `getOffsetTopRelativeToAncestor` (see `MasonryColumnsVirtual.tsx:103-107, :185-199`) needs to be replicated.
- **Ad interleaving**: `MasonryGrid` uses `useCreateAdFeed` to weave `{ type: 'ad', data: { AdUnit } }` items into the data stream. Preserve this — ads can show up in any slot, so slice the merged feed the same way. The ad unit has its own height (300×250 per [MasonryGrid.tsx:55-59](../../src/components/MasonryColumns/MasonryGrid.tsx#L55)), which might require a per-row height estimate if an ad lands in that row. Start by treating every row as `columnWidth` tall; revisit if ads visually break layout.
- **Single-column case**: `MasonryGrid` uses a CSS grid with `minmax(${columnWidth}px, ${maxSingleColumnWidth}px)` on single column. The virtual version needs to honor that too — same row structure, just one card per row.
- **`empty` state**: keep identical behavior — render the empty placeholder when `items.length === 0`.
- **`itemId` keys**: pass through for row+item keying to avoid remounts on reorder.

### Non-goals for v1

- Variable-height cards (those belong on `MasonryColumnsVirtual`).
- Replacing `UniformGrid` (finite lists, lower memory impact).
- Built-in `content-visibility` or `loading="lazy"` wrapping (separate follow-up).

## Migration plan

1. Build `MasonryGridVirtual` + a minimal unit/integration test if the codebase has a pattern for this.
2. Migrate [ModelsInfinite.tsx](../../src/components/Model/Infinite/ModelsInfinite.tsx) first as proof of concept — it's the highest-traffic and will surface any layout edge cases (ads, empty state, column-count transitions).
3. Smoke test `/models`, especially:
   - Scroll performance over 5+ pages.
   - Ad slot rendering.
   - Column-count transitions at breakpoint changes.
   - The "back button" / scroll-position restoration behavior.
4. Roll out to the remaining 7 feeds (articles, collections, comics, bounties, challenges, clubs, tools) — each should be a one-line import swap once v1 is proven.

## Complementary follow-ups (out of scope for this branch)

- Set `gcTime` on the global QueryClient ([utils/trpc.ts:69](../../src/utils/trpc.ts#L69)) and `maxPages` on feed infinite queries — caps memory even before virtualization lands.
- Add `loading="lazy"` + `content-visibility: auto` to feed image cards as a baseline mitigation.
- Broader audit items captured on the `feature/smaller-images` branch under [docs/optimization/browser-memory-audit.md](../../docs/optimization/browser-memory-audit.md).
