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
import { NextLink } from '@mantine/next';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import trieMemoize from 'trie-memoize';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';

type Props<Item> = {
  data: { id: number; name: string; items: Item[] }[];
  render: React.ComponentType<{ data: Item; height: number; index: number }>;
  itemId?: (data: Item) => string | number;
  isLoading?: boolean;
  fetchNextPage?: () => void;
  hasNextPage?: boolean;
  actions?: CategoryAction[] | ((items: Item[]) => CategoryAction[]);
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
  const { columnCount, maxSingleColumnWidth } = useMasonryContainerContext();

  useEffect(() => {
    if (inView) fetchNextPage?.();
  }, [fetchNextPage, inView]);

  return (
    <Stack
      sx={{
        position: 'relative',
        width: columnCount === 1 ? maxSingleColumnWidth : '100%',
        maxWidth: '100%',
        margin: '0 auto',
      }}
    >
      <LoadingOverlay visible={isLoading ?? false} zIndex={9} />
      {data.map((category) => {
        const actionableActions = typeof actions === 'function' ? actions(category.items) : actions;
        return (
          <Box key={category.id}>
            <Stack spacing={6}>
              <CategoryTitle
                id={category.id}
                name={category.name}
                actions={actionableActions?.filter((x) => x.inTitle)}
              />
              <CategoryCarousel
                data={category}
                render={RenderComponent}
                itemId={itemId}
                actions={actionableActions}
              />
            </Stack>
          </Box>
        );
      })}
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
  actions?: CategoryAction[];
};
function CategoryCarousel<Item>({
  data,
  render: RenderComponent,
  itemId,
  actions,
}: CategoryCarouselProps<Item>) {
  const { classes } = useStyles();
  const { columnCount } = useMasonryContainerContext();
  /**
   * items length + the context menu/buttons item
   */
  const totalItems = data.items.length + (actions?.length ? 1 : 0);

  return (
    <Box
      // bg="black"
      mx={-8}
      p={8}
      sx={(theme) => ({
        borderRadius: theme.radius.md,
        background: theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[2],
      })}
    >
      <Carousel
        classNames={classes}
        key={data.id}
        slideSize={`${100 / columnCount}%`}
        slideGap="md"
        align={totalItems <= columnCount ? 'start' : 'end'}
        withControls={totalItems > columnCount ? true : false}
        slidesToScroll={columnCount}
        loop
      >
        {data.items.map((item, index) => {
          const key = itemId ? itemId(item) : index;
          return (
            <Carousel.Slide key={key} id={key.toString()}>
              {createRenderElement(RenderComponent, index, item, 320)}
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
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data, height) => (
    <RenderComponent index={index} data={data} height={height} />
  )
);
