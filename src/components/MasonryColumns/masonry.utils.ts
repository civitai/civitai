import type {
  MasonryAdjustHeightFn,
  MasonryImageDimensionsFn,
} from '~/components/MasonryColumns/masonry.types';
import { useMemo } from 'react';
import type { AdFeedItem } from '~/components/Ads/ads.utils';
import { useCreateAdFeed } from '~/components/Ads/ads.utils';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Adunit_InContent } from '~/components/Ads/Playwire/Adunit';

export function useMasonryColumns<TData>(
  data: TData[],
  columnWidth: number,
  columnCount: number,
  imageDimensions: MasonryImageDimensionsFn<TData>,
  adjustDimensions?: MasonryAdjustHeightFn<TData>,
  maxItemHeight?: number,
  withAds?: boolean
) {
  const { adsEnabled } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const adsReallyAreEnabled = adsEnabled && getIsSafeBrowsingLevel(browsingLevel) && withAds;
  const createAdFeed = useCreateAdFeed();

  return useMemo(() => {
    if (columnCount === 0) return [];

    const feed = createAdFeed({
      data,
      columnCount,
      options: adsReallyAreEnabled
        ? [
            {
              width: 300,
              height: 250,
              AdUnit: Adunit_InContent,
            },
          ]
        : undefined,
    });

    const columnHeights: number[] = Array(columnCount).fill(0);
    const columnItems: ColumnItem<AdFeedItem<TData>>[][] = Array(columnCount).fill([]);

    for (const item of feed) {
      let height = 0;
      if (item.type === 'ad') {
        height = item.data.height;
      } else {
        const { width: originalWidth, height: originalHeight } = imageDimensions(item.data);

        const ratioHeight = (originalHeight / originalWidth) * columnWidth;
        const adjustedHeight =
          adjustDimensions?.(
            {
              imageRatio: columnWidth / ratioHeight,
              width: columnWidth,
              height: ratioHeight,
            },
            item.data
          ) ?? ratioHeight;
        height = Math.floor(
          maxItemHeight ? Math.min(adjustedHeight, maxItemHeight) : adjustedHeight
        );
      }

      // look for the shortest column on each iteration
      let shortest = 0;
      for (let j = 1; j < columnCount; ++j) {
        if (columnHeights[j] < columnHeights[shortest]) {
          shortest = j;
        }
      }
      columnHeights[shortest] += height;
      columnItems[shortest] = [...columnItems[shortest], { height, data: item }];
    }

    return columnItems;
  }, [data, columnWidth, columnCount, maxItemHeight, adsReallyAreEnabled]);
}

export type ColumnItem<TData> = {
  height: number;
  data: TData;
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
