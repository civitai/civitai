import OneKeyMap from '@essentials/one-key-map';
import { Carousel } from '@mantine/carousel';
import { Box, Button, Center, createStyles, Group, Loader, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import trieMemoize from 'trie-memoize';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';

type Props<Item> = {
  data: { id: number; name: string; items: Item[] }[];
  render: React.ComponentType<{ data: Item }>;
  itemId?: (data: Item) => string | number;
  isLoading?: boolean;
  fetchNextPage?: () => void;
  hasNextPage?: boolean;
  viewMoreHref?: (tag: number) => string;
};

export function CategoryList<Item>({
  data,
  render: RenderComponent,
  itemId,
  hasNextPage,
  isLoading,
  fetchNextPage,
  viewMoreHref,
}: Props<Item>) {
  const { ref, inView } = useInView();
  const { columnCount } = useMasonryContainerContext();

  useEffect(() => {
    if (inView) fetchNextPage?.();
  }, [fetchNextPage, inView]);

  return (
    <Stack>
      {data.map((category) => (
        <Box key={category.id}>
          <Stack spacing={6}>
            <CategoryTitle id={category.id} name={category.name} viewMoreHref={viewMoreHref} />
            <CategoryCarousel
              data={category}
              render={RenderComponent}
              itemId={itemId}
              slidesToScroll={columnCount}
            />
          </Stack>
        </Box>
      ))}
      {hasNextPage && !isLoading && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {inView && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

function CategoryTitle({
  id,
  name,
  viewMoreHref,
}: {
  id: number;
  name: string;
  viewMoreHref?: (tag: number) => string;
}) {
  return (
    <Group spacing="xs">
      <Text weight="bold" tt="uppercase" size="lg" lh={1}>
        {name}
      </Text>
      {viewMoreHref && (
        <Button component={NextLink} size="xs" variant="outline" compact href={viewMoreHref(id)}>
          View More
        </Button>
      )}
    </Group>
  );
}

type CategoryCarouselProps<Item> = {
  data: Props<Item>['data'][0];
  render: Props<Item>['render'];
  itemId?: Props<Item>['itemId'];
  slidesToScroll?: number;
};
function CategoryCarousel<Item>({
  data,
  render: RenderComponent,
  itemId,
  slidesToScroll = 2,
}: CategoryCarouselProps<Item>) {
  const { theme, classes } = useStyles();
  const mobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm}px)`);
  return (
    <Box bg="black" mx={-8} p={8} sx={(theme) => ({ borderRadius: theme.radius.md })}>
      <Carousel
        classNames={classes}
        key={data.id}
        slideSize={constants.cardSizes.image}
        breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 5 }]}
        slideGap="md"
        align="start"
        withControls={data.items.length > slidesToScroll ? true : false}
        slidesToScroll={mobile ? 1 : slidesToScroll}
        loop
      >
        {data.items.map((item, index) => {
          const key = itemId ? itemId(item) : index;
          return (
            <Carousel.Slide key={key} id={key.toString()}>
              {createRenderElement(RenderComponent, index, item)}
            </Carousel.Slide>
          );
        })}
      </Carousel>
    </Box>
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
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, data) => <RenderComponent data={data} />
);
