import React, { useCallback, useEffect, useRef } from 'react';
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
};

export function MasonryColumnsVirtual<TData>({
  data,
  render,
  imageDimensions,
  adjustHeight,
  maxItemHeight,
  itemId,
  withAds,
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
  ...rest
}: {
  items: ColumnItem<AdFeedItem<TData>>[];
  className?: string;
  style?: React.CSSProperties;
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
  columnWidth: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useScrollAreaRef();

  //  console.log({
  //   ref: ref.current?.getBoundingClientRect(),
  //   scrollArea: scrollAreaRef?.current?.getBoundingClientRect(),
  // });

  // const refTop = ref.current?.getBoundingClientRect().top ?? 0;
  // const scrollAreaTop = scrollAreaRef?.current?.getBoundingClientRect().top ?? 0;
  // const scrollMargin = refTop - scrollAreaTop;

  // console.log({ scrollMargin });

  const getItemKey = useCallback(
    (i: number) => {
      const { data } = items[i];
      if (data.type === 'data') return itemId?.(data.data) ?? i;
      return i;
    },
    [items]
  );

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: (i) => items[i].height,
    overscan: 5,
    // scrollMargin: ref.current?.parentElement?.offsetTop ?? 0,
    getItemKey,
    gap: 16,
  });

  return (
    <div
      ref={ref}
      className={className}
      style={{ ...style, height: rowVirtualizer.getTotalSize(), position: 'relative' }}
    >
      {rowVirtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key.toString()}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${item.start}px)`,
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
  itemId,
  columnWidth,
  index,
}: {
  item: ColumnItem<AdFeedItem<TData>>;
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  itemId?: (data: TData) => string | number;
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
