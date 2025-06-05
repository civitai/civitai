import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import React from 'react';
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

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  imageDimensions: MasonryImageDimensionsFn<TData>;
  adjustHeight?: MasonryAdjustHeightFn<TData>;
  maxItemHeight?: number;
  itemId?: (data: TData) => string | number;
  staticItem?: (props: { columnWidth: number; height: number }) => React.ReactNode;
  /** [lowerInterval, upperInterval] */
  withAds?: boolean;
};

export function MasonryColumns<TData>({
  data,
  render: RenderComponent,
  imageDimensions,
  adjustHeight,
  maxItemHeight,
  itemId,
  staticItem,
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
        <div
          key={colIndex}
          className={clsx(
            'flex max-w-[450px] flex-col gap-4',
            columnCount === 1 ? 'w-full' : 'w-[320px]'
          )}
          style={columnCount > 1 ? { width: columnWidth } : undefined}
        >
          {staticItem?.({ columnWidth, height: 450 })}
          {items.map(({ height, data }, index) => {
            switch (data.type) {
              case 'data':
                return (
                  <RenderComponent
                    key={itemId?.(data.data) ?? index}
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
            }
          })}
        </div>
      ))}
    </div>
  );
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap, OneKeyMap],
  (RenderComponent, index, data, columnWidth, columnHeight) => (
    <RenderComponent index={index} data={data} width={columnWidth} height={columnHeight} />
  )
);
