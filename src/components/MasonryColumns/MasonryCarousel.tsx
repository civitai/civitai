import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import clsx from 'clsx';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  extra?: React.ReactNode;
  height?: number;
  itemId?: (data: TData) => string | number;
  id?: string | number;
  empty?: React.ReactNode;
  itemWrapperProps?: React.HTMLAttributes<HTMLDivElement>;
  viewportClassName?: string;
};

export function MasonryCarousel<TData>({
  data,
  render: RenderComponent,
  extra,
  height,
  itemId,
  id,
  empty,
  itemWrapperProps,
  viewportClassName,
}: Props<TData>) {
  const { columnCount, columnWidth, maxSingleColumnWidth } = useMasonryContext();

  const totalItems = data.length + (extra ? 1 : 0);

  return data.length ? (
    <Embla
      key={id}
      className={viewportClassName}
      align={totalItems <= columnCount ? 'start' : 'end'}
      withControls={totalItems > columnCount ? true : false}
      slidesToScroll={columnCount}
      controlSize={32}
      // height={columnCount === 1 ? maxSingleColumnWidth : '100%'}
      loop
      style={{
        width: columnCount === 1 ? maxSingleColumnWidth : '100%',
        maxWidth: '100%',
        margin: '0 auto',
        minHeight: height,
      }}
    >
      <Embla.Viewport>
        <Embla.Container className="-ml-4 flex">
          {data.map((item, index) => {
            const key = itemId ? itemId(item) : index;
            return (
              <Embla.Slide
                {...itemWrapperProps}
                key={key}
                id={key.toString()}
                index={index}
                className={clsx('pl-4', columnCount > 1 ? 'basis-[336px]' : 'flex-[0_0_100%]')}
              >
                {createRenderElement(RenderComponent, index, item, height)}
              </Embla.Slide>
            );
          })}
          {extra && (
            <Embla.Slide
              index={data.length}
              className={clsx('pl-4', columnCount > 1 ? 'basis-[336px]' : 'flex-[0_0_100%]')}
            >
              {extra}
            </Embla.Slide>
          )}
        </Embla.Container>
      </Embla.Viewport>
    </Embla>
  ) : (
    <div style={{ height: columnWidth }}>{empty}</div>
  );
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data, height) => (
    <RenderComponent index={index} data={data} height={height} />
  )
);
