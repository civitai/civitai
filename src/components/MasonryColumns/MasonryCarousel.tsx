import OneKeyMap from '@essentials/one-key-map';
import { Carousel } from '@mantine/carousel';
import { createStyles } from '@mantine/core';
import trieMemoize from 'trie-memoize';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  extra?: React.ReactNode;
  height?: number;
  itemId?: (data: TData) => string | number;
  id?: string | number;
  empty?: React.ReactNode;
  itemWrapperProps?: React.HTMLAttributes<HTMLDivElement>;
  loop?: boolean;
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
  loop = true,
}: Props<TData>) {
  const { classes } = useStyles({ loop });
  const { columnCount, columnWidth, maxSingleColumnWidth } = useMasonryContext();

  const totalItems = data.length + (extra ? 1 : 0);
  // const key = id ?? (itemId ? data.map(itemId).join('_') : undefined);

  return data.length ? (
    <Carousel
      key={id}
      classNames={classes}
      slideSize={`${100 / columnCount}%`}
      slideGap="md"
      align={totalItems <= columnCount ? 'start' : 'end'}
      withControls={totalItems > columnCount ? true : false}
      slidesToScroll={columnCount}
      // height={columnCount === 1 ? maxSingleColumnWidth : '100%'}
      loop={loop}
      sx={{
        width: columnCount === 1 ? maxSingleColumnWidth : '100%',
        maxWidth: '100%',
        margin: '0 auto',
        minHeight: height,
      }}
    >
      {data.map((item, index) => {
        const key = itemId ? itemId(item) : index;
        return (
          <Carousel.Slide {...itemWrapperProps} key={key} id={key.toString()}>
            {createRenderElement(RenderComponent, index, item, height)}
          </Carousel.Slide>
        );
      })}
      {extra && <Carousel.Slide>{extra}</Carousel.Slide>}
    </Carousel>
  ) : (
    <div style={{ height: columnWidth }}>{empty}</div>
  );
}

const useStyles = createStyles<string, { loop?: boolean }>((_theme, params) => ({
  control: {
    svg: {
      width: 32,
      height: 32,

      [containerQuery.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },

    '&[data-inactive]': {
      opacity: 0,
      cursor: 'default',
    },
  },
  viewport: {
    overflow: params.loop ? 'hidden' : 'visible',
  },
}));

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data, height) => (
    <RenderComponent index={index} data={data} height={height} />
  )
);
