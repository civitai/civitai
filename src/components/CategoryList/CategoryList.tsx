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
import { useMediaQuery } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { useRouter } from 'next/router';
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
  actions?: CategoryAction[];
};

type CategoryAction = {
  label: string | ((category: { id: number; name: string }) => string);
  href: string | ((category: { id: number; name: string }) => string);
  icon?: React.ReactNode;
  inTitle?: boolean;
  shallow?: boolean;
};

export function CategoryList<Item>({
  data,
  render: RenderComponent,
  itemId,
  hasNextPage,
  isLoading,
  fetchNextPage,
  actions,
}: Props<Item>) {
  const { ref, inView } = useInView();
  const { columnCount } = useMasonryContainerContext();

  useEffect(() => {
    if (inView) fetchNextPage?.();
  }, [fetchNextPage, inView]);

  return (
    <Stack sx={{ position: 'relative' }}>
      <LoadingOverlay visible={isLoading ?? false} zIndex={9} />
      {data.map((category) => (
        <Box key={category.id}>
          <Stack spacing={6}>
            <CategoryTitle
              id={category.id}
              name={category.name}
              actions={actions?.filter((x) => x.inTitle)}
            />
            <CategoryCarousel
              data={category}
              render={RenderComponent}
              itemId={itemId}
              slidesToScroll={columnCount}
              actions={actions}
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
  actions,
}: {
  id: number;
  name: string;
  actions?: CategoryAction[];
}) {
  return (
    <Group spacing="xs">
      <Text
        weight="bold"
        tt="uppercase"
        size="lg"
        lh={1}
        sx={(theme) => ({
          [theme.fn.smallerThan('sm')]: {
            marginRight: 'auto',
          },
        })}
      >
        {name}
      </Text>
      {actions?.map((action, index) => (
        <Button
          key={index}
          component={NextLink}
          href={typeof action.href === 'function' ? action.href({ id, name }) : action.href}
          variant="outline"
          size="xs"
          shallow={action.shallow}
          compact
        >
          {typeof action.label === 'function' ? action.label({ id, name }) : action.label}
        </Button>
      ))}
    </Group>
  );
}

type CategoryCarouselProps<Item> = {
  data: Props<Item>['data'][0];
  render: Props<Item>['render'];
  itemId?: Props<Item>['itemId'];
  slidesToScroll?: number;
  actions?: CategoryAction[];
};
function CategoryCarousel<Item>({
  data,
  render: RenderComponent,
  itemId,
  slidesToScroll = 2,
  actions,
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
        withControls={data.items.length + (actions?.length ? 1 : 0) > slidesToScroll ? true : false}
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
        {actions && (
          <Carousel.Slide key="view-more">
            <Stack h="100%" spacing="md">
              {actions.map((action, index) => (
                <Button
                  key={index}
                  className={classes.moreActions}
                  component={NextLink}
                  href={typeof action.href === 'function' ? action.href(data) : action.href}
                  variant="outline"
                  fullWidth
                  radius="md"
                  size="lg"
                  rightIcon={action.icon}
                  shallow={action.shallow}
                >
                  {typeof action.label === 'function' ? action.label(data) : action.label}
                </Button>
              ))}
            </Stack>
          </Carousel.Slide>
        )}
      </Carousel>
    </Box>
  );
}

const useStyles = createStyles((theme) => ({
  container: {
    minHeight: 200,
  },
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

  moreActions: {
    width: '100%',
    flex: '1',
  },
}));

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, data) => <RenderComponent data={data} />
);
