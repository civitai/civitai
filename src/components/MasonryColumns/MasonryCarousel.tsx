import OneKeyMap from '@essentials/one-key-map';
import { Carousel } from '@mantine/carousel';
import {
  Box,
  Button,
  Center,
  createStyles,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
} from '@mantine/core';
import trieMemoize from 'trie-memoize';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';

type Props<TData> = {
  data: TData[];
  render: React.ComponentType<MasonryRenderItemProps<TData>>;
  extra?: React.ReactNode;
  height?: number;
  itemId?: (data: TData) => string | number;
  id?: string | number;
  empty?: React.ReactNode;
};

export function MasonryCarousel<TData>({
  data,
  render: RenderComponent,
  extra,
  height,
  itemId,
  id,
  empty,
}: Props<TData>) {
  const { classes } = useStyles();
  const { columnCount, columnWidth, maxSingleColumnWidth } = useMasonryContainerContext();

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
      loop
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
          <Carousel.Slide key={key} id={key.toString()}>
            <div style={{ position: 'relative', paddingTop: '100%' }}>
              {createRenderElement(RenderComponent, index, item, height)}
            </div>
          </Carousel.Slide>
        );
      })}
      {extra && (
        <Carousel.Slide>
          <div style={{ position: 'relative', paddingTop: '100%' }}>{extra}</div>
        </Carousel.Slide>
      )}
    </Carousel>
  ) : (
    <div style={{ height: columnWidth }}>{empty}</div>
  );
}

const useStyles = createStyles((theme) => ({
  control: {
    svg: {
      width: 32,
      height: 32,

      [theme.fn.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },
  },
}));

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data, height) => (
    <RenderComponent index={index} data={data} height={height} />
  )
);
