import type {
  MasonryAdjustHeightFn,
  MasonryImageDimensionsFn,
} from '~/components/MasonryColumns/masonry.types';
import { useMemo } from 'react';
import type { AdFeedItem } from '~/components/Ads/ads.utils';
import { useCreateAdFeed } from '~/components/Ads/ads.utils';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { AdUnitIncontent_1 } from '~/components/Ads/AdUnit';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

/**
 * Columns that fit in `width`. 0 means "not measured": a hidden container can measure negative
 * (clientWidth 0 minus its padding), which must not become a column count.
 */
export function getColumnCount(
  width: number,
  columnWidth: number,
  maxColumnCount: number,
  gap = 16
) {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const fit = Math.floor((width + gap) / (columnWidth + gap));
  const count = Math.floor(Math.min(fit, maxColumnCount));
  return Number.isFinite(count) ? Math.max(1, count) : 1;
}

/** Gap between cards, matching the virtualizer's `gap` in MasonryColumnsVirtual. */
export const MASONRY_GAP = 16;

export type MasonrySpanOptions = {
  /** Smallest width/height an item needs to span two columns. */
  minRatio: number;
  /** Cap on a two-wide item's total height (footer included). */
  maxHeight: number;
  /** More pages are coming: hold a wide item back until its lookahead window is full. */
  holdTail?: boolean;
};

/** 16:9 or wider (>= 1.75, so 1344x768 counts). */
export const MASONRY_SPAN_MIN_RATIO = 1.75;
/** A two-wide item needs three columns: two to span, one to keep a normal feed beside it. */
const SPAN_MIN_COLUMNS = 3;
/** How many items after a wide one are candidates to fill the blank room beside it. */
export const MASONRY_FILL_LOOKAHEAD = 8;
/** Blank room this small stays a spacer rather than being filled. */
export const MASONRY_MIN_FILL_ROOM = 48;

export function useMasonryColumns<TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  imageDimensions: MasonryImageDimensionsFn<TData>,
  adjustDimensions?: MasonryAdjustHeightFn<TData>,
  maxItemHeight?: number,
  withAds?: boolean,
  span?: MasonrySpanOptions
) {
  const { adsEnabled } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const adsReallyAreEnabled = adsEnabled && getIsSafeBrowsingLevel(browsingLevel) && withAds;
  const createAdFeed = useCreateAdFeed();
  const spanMinRatio = span?.minRatio;
  const spanMaxHeight = span?.maxHeight;
  const holdTail = span?.holdTail ?? false;

  return useMemo(() => {
    // 0 = not laid out yet. Anything else non-positive/fractional is a bad measurement; render
    // nothing rather than throw from Array(n).
    if (!Number.isInteger(columnCount) || columnCount < 1) return [];

    const feed = createAdFeed({
      data,
      columnCount,
      options: adsReallyAreEnabled
        ? [
            {
              width: 300,
              height: 250,
              AdUnit: AdUnitIncontent_1,
            },
          ]
        : undefined,
    });

    const itemHeight = (item: AdFeedItem<TData>, width: number, cap: number | undefined) => {
      if (item.type === 'ad') return item.data.height;
      const { width: originalWidth, height: originalHeight } = imageDimensions(item.data);
      const ratioHeight = (originalHeight / originalWidth) * width;
      const adjustedHeight =
        adjustDimensions?.(
          { imageRatio: width / ratioHeight, width, height: ratioHeight },
          item.data
        ) ?? ratioHeight;
      return Math.floor(cap ? Math.min(adjustedHeight, cap) : adjustedHeight);
    };

    if (
      spanMinRatio === undefined ||
      spanMaxHeight === undefined ||
      columnCount < SPAN_MIN_COLUMNS
    ) {
      const columnHeights: number[] = Array(columnCount).fill(0);
      const columnItems: ColumnItem<AdFeedItem<TData>>[][] = Array.from(
        { length: columnCount },
        () => []
      );

      for (const item of feed) {
        const height = itemHeight(item, columnWidth, maxItemHeight);

        // look for the shortest column on each iteration
        let shortest = 0;
        for (let j = 1; j < columnCount; ++j) {
          if (columnHeights[j] < columnHeights[shortest]) {
            shortest = j;
          }
        }
        columnHeights[shortest] += height;
        columnItems[shortest].push({ height, data: item });
      }

      return columnItems;
    }

    // Spanning layout. `ends` is where each column's last item stops; the next item starts a gap
    // below it, so two columns line up only if their gaps are counted too.
    const spanWidth = columnWidth * 2 + MASONRY_GAP;
    const ends: number[] = Array(columnCount).fill(0);
    const counts: number[] = Array(columnCount).fill(0);
    const columnItems: ColumnItem<AdFeedItem<TData>>[][] = Array.from(
      { length: columnCount },
      () => []
    );
    const nextStart = (c: number) => (counts[c] ? ends[c] + MASONRY_GAP : 0);

    const spansWide = (item: AdFeedItem<TData>) => {
      if (item.type !== 'data') return false;
      const { width, height } = imageDimensions(item.data);
      return height > 0 && width / height >= spanMinRatio;
    };
    const placeSingle = (item: AdFeedItem<TData>, column: number, height: number) => {
      columnItems[column].push({ height, data: item });
      ends[column] = nextStart(column) + height;
      counts[column]++;
    };
    const placed = new Set<number>();

    for (let index = 0; index < feed.length; index++) {
      if (placed.has(index)) continue;
      const item = feed[index];

      if (!spansWide(item)) {
        const height = itemHeight(item, columnWidth, maxItemHeight);
        let shortest = 0;
        for (let j = 1; j < columnCount; ++j) {
          if (nextStart(j) < nextStart(shortest)) shortest = j;
        }
        placeSingle(item, shortest, height);
        continue;
      }

      // Its lookahead must be fully loaded, or a later page could pull a filler in and reflow it.
      if (holdTail && index + MASONRY_FILL_LOOKAHEAD >= feed.length) break;

      // The adjacent pair that costs least: how far down the item begins plus the blank room left
      // beside it in the shorter column. Ties go to the left.
      let pair = 0;
      let pairStart = 0;
      let pairCost = Infinity;
      for (let j = 0; j < columnCount - 1; ++j) {
        let start = Math.max(nextStart(j), nextStart(j + 1));
        // A spacer is at least a gap tall, so a shorter lead column cannot be padded by less.
        if (nextStart(j) < start && start - nextStart(j) < MASONRY_GAP) {
          start = nextStart(j) + MASONRY_GAP;
        }
        const cost = start + Math.abs(nextStart(j) - nextStart(j + 1));
        if (cost < pairCost) {
          pair = j;
          pairStart = start;
          pairCost = cost;
        }
      }

      // Pull later single-column items that fit into the shorter column's blank room.
      const shorter = nextStart(pair) <= nextStart(pair + 1) ? pair : pair + 1;
      const target = Math.max(nextStart(pair), nextStart(pair + 1));
      const lookaheadEnd = Math.min(feed.length, index + 1 + MASONRY_FILL_LOOKAHEAD);
      for (let k = index + 1; k < lookaheadEnd; k++) {
        if (target - nextStart(shorter) <= MASONRY_MIN_FILL_ROOM) break;
        const candidate = feed[k];
        if (placed.has(k) || candidate.type !== 'data' || spansWide(candidate)) continue;
        const candidateHeight = itemHeight(candidate, columnWidth, maxItemHeight);
        if (nextStart(shorter) + candidateHeight + MASONRY_GAP > target) continue;
        placeSingle(candidate, shorter, candidateHeight);
        placed.add(k);
      }
      pairStart = Math.max(nextStart(pair), nextStart(pair + 1));
      if (nextStart(pair) < pairStart && pairStart - nextStart(pair) < MASONRY_GAP) {
        pairStart = nextStart(pair) + MASONRY_GAP;
      }

      const height = itemHeight(item, spanWidth, spanMaxHeight);
      const partner = pair + 1;
      const leadGap = pairStart - nextStart(pair);
      if (leadGap > 0) {
        columnItems[pair].push({ height: leadGap - MASONRY_GAP, spacer: true });
        counts[pair]++;
      }
      columnItems[pair].push({ height, data: item, span: 2 });
      counts[pair]++;
      ends[pair] = pairStart + height;

      // One spacer holds the partner's whole stretch under the wide item, lead included.
      columnItems[partner].push({ height: pairStart + height - nextStart(partner), spacer: true });
      counts[partner]++;
      ends[partner] = pairStart + height;
    }

    return columnItems;
  }, [
    data,
    columnWidth,
    columnCount,
    maxItemHeight,
    adsReallyAreEnabled,
    spanMinRatio,
    spanMaxHeight,
    holdTail,
  ]);
}

export type ColumnItem<TData> =
  | {
      height: number;
      data: TData;
      /** Columns the item covers; absent means one. */
      span?: number;
      spacer?: undefined;
    }
  | {
      /** Blank room under (or before) a wide item that spans into this column. */
      height: number;
      spacer: true;
      data?: undefined;
      span?: undefined;
    };

// const getMasonryColumns = <TData>(
//   data: TData[],
//   columnWidth: number,
//   columnCount: number,
//   imageDimensions: MasonryImageDimensionsFn<TData>,
//   adjustHeight?: MasonryAdjustHeightFn<TData>,
//   maxItemHeight?: number,
//   showAds?: boolean
// ): ColumnItem<AdFeedItem<TData>>[][] => {
//   // Track the height of each column.
//   // Layout algorithm below always inserts into the shortest column.
//   if (columnCount === 0) return [];

//   const feed = createAdFeed({
//     data,
//     columnCount,
//     keys: showAds ? ['300x250:Dynamic_Feeds', '300x600:Dynamic_Feeds'] : undefined,
//   });

//   const columnHeights: number[] = Array(columnCount).fill(0);
//   const columnItems: ColumnItem<AdFeedItem<TData>>[][] = Array(columnCount).fill([]);

//   for (const item of feed) {
//     let height = 0;
//     if (item.type === 'ad') {
//       height = item.data.height + 20;
//     } else {
//       const { width: originalWidth, height: originalHeight } = imageDimensions(item.data);

//       const ratioHeight = (originalHeight / originalWidth) * columnWidth;
//       const adjustedHeight =
//         adjustHeight?.(
//           {
//             imageRatio: columnWidth / ratioHeight,
//             width: columnWidth,
//             height: ratioHeight,
//           },
//           item.data
//         ) ?? ratioHeight;
//       height = maxItemHeight ? Math.min(adjustedHeight, maxItemHeight) : adjustedHeight;
//     }

//     // look for the shortest column on each iteration
//     let shortest = 0;
//     for (let j = 1; j < columnCount; ++j) {
//       if (columnHeights[j] < columnHeights[shortest]) {
//         shortest = j;
//       }
//     }
//     columnHeights[shortest] += height;
//     columnItems[shortest] = [...columnItems[shortest], { height, data: item }];
//   }

//   return columnItems;
// };
