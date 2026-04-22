import { Button, Text, useComputedColorScheme } from '@mantine/core';
import { IconCaretRightFilled } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Image from 'next/image';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AdUnitIncontent_1 } from '~/components/Ads/AdUnit';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useCreateAdFeed } from '~/components/Ads/ads.utils';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { TwCard } from '~/components/TwCard/TwCard';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

// Matches the aspectRatioMap in ~/components/CardTemplates/AspectRatioCard.tsx.
// Values are width/height ratios, so rowHeight = columnWidth / cardAspectRatio.
const cardAspectRatioMap = {
  portrait: 7 / 9,
  landscape: 9 / 7,
  square: 1,
} as const;

type CardAspectRatio = keyof typeof cardAspectRatioMap;

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  empty?: React.ReactNode;
  withAds?: boolean;
  overscan?: number;
  /** Aspect ratio the card renders at. Must match the render component. Defaults to 'portrait' to match AspectRatioCard. */
  aspectRatio?: CardAspectRatio;
};

export function MasonryGridVirtual<TData>({
  data,
  render: RenderComponent,
  itemId,
  empty = null,
  withAds,
  overscan = 4,
  aspectRatio = 'portrait',
}: Props<TData>) {
  const colorScheme = useComputedColorScheme('dark');
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();
  const rowHeight = Math.round(columnWidth / cardAspectRatioMap[aspectRatio]);

  const { adsEnabled, useDirectAds } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const adsReallyAreEnabled =
    adsEnabled && !useDirectAds && getIsSafeBrowsingLevel(browsingLevel) && withAds;
  const createAdFeed = useCreateAdFeed();
  // Only interleave ads when they'll actually render. Otherwise AdUnitRenderable
  // short-circuits to null and leaves visible empty cells in the pre-sliced rows
  // (MasonryGrid's flat auto-flow grid absorbs those gaps; a row-based virtualizer
  // can't).
  const items = useMemo(
    () =>
      createAdFeed({
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
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnCount, data, adsReallyAreEnabled]
  );

  const rowCount = Math.ceil(items.length / columnCount);

  const ref = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useScrollAreaRef();

  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (ref.current && scrollAreaRef?.current) {
      setScrollMargin(getOffsetTopRelativeToAncestor(ref.current, scrollAreaRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getRowKey = useCallback(
    (rowIndex: number) => {
      const firstItem = items[rowIndex * columnCount];
      if (!firstItem) return rowIndex;
      if (firstItem.type === 'data') return itemId?.(firstItem.data) ?? rowIndex;
      return `row_${rowIndex}`;
    },
    [items, columnCount, itemId]
  );

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: getRowKey,
    gap: rowGap,
    scrollMargin,
    initialOffset: () => scrollAreaRef?.current?.scrollTop ?? 0,
  });

  if (!items.length) {
    return <div style={{ height: columnWidth }}>{empty}</div>;
  }

  const gridTemplateColumns =
    columnCount === 1
      ? `minmax(${columnWidth}px, ${maxSingleColumnWidth ?? columnWidth}px)`
      : `repeat(${columnCount}, ${columnWidth}px)`;

  return (
    <div
      ref={ref}
      style={{
        height: rowVirtualizer.getTotalSize(),
        position: 'relative',
        width: '100%',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const startIdx = virtualRow.index * columnCount;
        const rowItems = items.slice(startIdx, startIdx + columnCount);

        return (
          <div
            key={`${virtualRow.index}_${virtualRow.key}`}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              display: 'grid',
              justifyContent: 'center',
              gridTemplateColumns,
              columnGap,
              transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
            }}
          >
            {rowItems.map((item, cellIdx) => {
              const index = startIdx + cellIdx;
              if (item.type === 'data') {
                const key = itemId?.(item.data) ?? index;
                return (
                  <RenderComponent
                    key={key}
                    index={index}
                    data={item.data}
                    width={columnWidth}
                    height={columnWidth}
                  />
                );
              }
              return (
                <AdUnitRenderable key={`ad_${index}`}>
                  <TwCard className="mx-auto min-w-80 justify-between gap-2 border p-2 shadow">
                    <div className="flex flex-col items-center gap-2">
                      <Image
                        src={`/images/logo_${colorScheme}_mode.png`}
                        alt="Civitai logo"
                        height={30}
                        width={142}
                      />
                      <Text>Become a Member to turn off ads today.</Text>
                      <Button
                        component={Link}
                        href="/pricing"
                        size="compact-sm"
                        color="green"
                        variant="outline"
                        className="w-24"
                      >
                        <Text fw={500}>Do It</Text>
                        <IconCaretRightFilled size={16} />
                      </Button>
                    </div>
                    <div>
                      <item.data.AdUnit />
                    </div>
                  </TwCard>
                </AdUnitRenderable>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function getOffsetTopRelativeToAncestor(descendant: HTMLElement, ancestor: HTMLElement): number {
  let offset = 0;
  let current: HTMLElement | null = descendant;

  while (current && current !== ancestor) {
    offset += current.offsetTop;
    current = current.offsetParent as HTMLElement;
  }

  if (current !== ancestor) {
    throw new Error('Ancestor is not an offsetParent of the descendant');
  }

  return offset;
}
