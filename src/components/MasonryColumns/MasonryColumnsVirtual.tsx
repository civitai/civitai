import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ColumnItem } from '~/components/MasonryColumns/masonry.utils';
import { useMasonryColumns } from '~/components/MasonryColumns/masonry.utils';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import type {
  MasonryRenderItemProps,
  MasonryAdjustHeightFn,
  MasonryImageDimensionsFn,
} from '~/components/MasonryColumns/masonry.types';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { TwCard } from '~/components/TwCard/TwCard';
import clsx from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import type { AdFeedItem } from '~/components/Ads/ads.utils';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  imageDimensions: MasonryImageDimensionsFn<TData>;
  adjustHeight?: MasonryAdjustHeightFn<TData>;
  maxItemHeight?: number;
  itemId?: (data: TData) => string | number;
  /** [lowerInterval, upperInterval] */
  withAds?: boolean;
  overscan?: number;
};

export function MasonryColumnsVirtual<TData>({
  data,
  render,
  imageDimensions,
  adjustHeight,
  maxItemHeight,
  itemId,
  withAds,
  overscan,
}: Props<TData>) {
  const { columnCount, columnWidth } = useMasonryContext();

  const columns = useMasonryColumns(
    data,
    columnWidth,
    columnCount,
    imageDimensions,
    adjustHeight,
    maxItemHeight,
    withAds
  );

  return (
    <div className="mx-auto flex justify-center gap-4">
      {columns.map((items, colIndex) => (
        <VirtualColumn
          key={colIndex}
          items={items}
          render={render}
          itemId={itemId}
          columnWidth={columnWidth}
          className={clsx(
            'flex max-w-[450px] flex-col gap-4',
            columnCount === 1 ? 'w-full' : 'w-[320px]'
          )}
          style={columnCount > 1 ? { width: columnWidth } : undefined}
          overscan={overscan}
        />
      ))}
    </div>
  );
}

function VirtualColumn<TData>({
  items,
  className,
  style,
  itemId,
  overscan = 5,
  ...rest
}: {
  items: ColumnItem<AdFeedItem<TData>>[];
  className?: string;
  style?: React.CSSProperties;
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  columnWidth: number;
  overscan?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useScrollAreaRef();

  const getItemKey = useCallback(
    (i: number) => {
      const { data } = items[i];
      if (data.type === 'data') return itemId?.(data.data) ?? i;
      return i;
    },
    [items]
  );

  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (ref.current && scrollAreaRef?.current) {
      setScrollMargin(getOffsetTopRelativeToAncestor(ref.current, scrollAreaRef.current));
    }
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: (i) => items[i].height,
    overscan,
    getItemKey,
    gap: 16,
    scrollMargin,
    initialOffset: () => scrollAreaRef?.current?.scrollTop ?? 0,
  });

  return (
    <div
      ref={ref}
      className={className}
      style={{
        width: '100%',
        ...style,
        height: rowVirtualizer.getTotalSize(),
        position: 'relative',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((item) => (
        <div
          key={`${item.index}_${item.key}`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: items[item.index].height,
            overflow: 'hidden',
            transform: `translateY(${item.start - rowVirtualizer.options.scrollMargin}px)`,
          }}
        >
          <VirtualItem index={item.index} item={items[item.index]} {...rest} />
        </div>
      ))}
    </div>
  );
}

function VirtualItem<TData>({
  item: { height, data },
  render: RenderComponent,
  columnWidth,
  index,
}: {
  item: ColumnItem<AdFeedItem<TData>>;
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  columnWidth: number;
  index: number;
}) {
  switch (data.type) {
    case 'data':
      return (
        <RenderComponent
          // key={itemId?.(data.data) ?? index}
          index={index}
          data={data.data}
          width={columnWidth}
          height={height}
        />
      );
    case 'ad':
      return (
        <AdUnitRenderable key={`ad_${index}`}>
          <TwCard className="w-full items-center justify-center shadow">
            <data.data.AdUnit />
          </TwCard>
        </AdUnitRenderable>
      );
    default:
      return null;
  }
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
