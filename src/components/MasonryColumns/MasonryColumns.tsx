import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import React from 'react';
import { useMasonryColumns } from '~/components/MasonryColumns/masonry.utils';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import {
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
          className={clsx('flex max-w-[450px] flex-col gap-4', { ['w-full']: columnCount === 1 })}
          style={columnCount > 1 ? { width: columnWidth } : undefined}
        >
          {items.map(({ height, data }, index) => {
            const key = data.type === 'data' ? itemId?.(data.data) ?? index : `ad_${index}`;
            const showStaticItem = colIndex === 0 && index === 0 && staticItem;

            return (
              <React.Fragment key={key}>
                {showStaticItem && staticItem({ columnWidth, height: 450 })}
                {data.type === 'data' &&
                  createRenderElement(RenderComponent, index, data.data, columnWidth, height)}
                {data.type === 'ad' && (
                  <AdUnitRenderable>
                    <TwCard className="w-full items-center justify-center py-2 shadow">
                      <data.data.AdUnit lazyLoad />
                    </TwCard>
                  </AdUnitRenderable>
                )}
              </React.Fragment>
            );
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
