import { Carousel } from '@mantine/carousel';
import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { UniformGrid } from '~/components/MasonryColumns/UniformGrid';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { NoContent } from '~/components/NoContent/NoContent';
import { useIsMobile } from '~/hooks/useIsMobile';

type Props<Item> = {
  data: Array<TypeCategory & { items: Item[] }>;
  render: React.ComponentType<MasonryRenderItemProps<Item>>;
  itemId?: (data: Item) => string | number;
  isLoading?: boolean;
  isRefetching?: boolean;
  fetchNextPage?: () => void;
  hasNextPage?: boolean;
  actions?: (category: TypeCategory) => CategoryAction[];
  empty?: (data: { id: number; name: string }) => React.ReactNode;
};

type CategoryAction = {
  label: string;
  href: string;
  icon?: React.ReactNode;
  inTitle?: boolean;
  shallow?: boolean;
  visible?: boolean;
};

export function CategoryList<Item>({
  data,
  render: RenderComponent,
  itemId,
  hasNextPage,
  isLoading,
  isRefetching,
  fetchNextPage,
  actions,
  empty,
}: Props<Item>) {
  const { ref, inView } = useInView();
  const { columnCount, maxSingleColumnWidth, columnWidth } = useMasonryContainerContext();
  const { classes } = useStyles();

  const isMobile = useIsMobile();

  useEffect(() => {
    if (inView) fetchNextPage?.();
  }, [fetchNextPage, inView]);

  return isLoading ? (
    <Center p="xl">
      <Loader size="xl" />
    </Center>
  ) : (
    <Stack
      sx={{
        position: 'relative',
        width: columnCount === 1 ? maxSingleColumnWidth : '100%',
        maxWidth: '100%',
        margin: '0 auto',
      }}
    >
      {isRefetching && <LoadingOverlay visible zIndex={9} />}
      {data.map((category) => {
        const actionableActions = actions?.(category)?.filter((x) => x.visible ?? true);

        return (
          <Box key={category.id}>
            <Stack spacing={6}>
              <CategoryTitle
                id={category.id}
                name={category.name}
                actions={actionableActions?.filter((x) => x.inTitle)}
              />
              <Box
                mx={-8}
                p={8}
                sx={(theme) => ({
                  borderRadius: theme.radius.md,
                  background:
                    theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[2],
                })}
              >
                {!isMobile ? (
                  <UniformGrid
                    data={category.items}
                    render={RenderComponent}
                    itemId={itemId}
                    empty={empty?.({ id: category.id, name: category.name })}
                  />
                ) : (
                  <MasonryCarousel
                    data={category.items}
                    render={RenderComponent}
                    itemId={itemId}
                    height={columnWidth}
                    empty={empty?.({ id: category.id, name: category.name })}
                    extra={
                      actionableActions ? (
                        <Stack
                          spacing="md"
                          p="xl"
                          sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                        >
                          {actionableActions.map((action, index) => (
                            <Button
                              key={index}
                              className={classes.moreActions}
                              component={NextLink}
                              href={action.href}
                              variant="outline"
                              fullWidth
                              radius="md"
                              size="lg"
                              rightIcon={action.icon}
                              shallow={action.shallow}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </Stack>
                      ) : null
                    }
                  />
                )}
              </Box>
            </Stack>
          </Box>
        );
      })}
      {hasNextPage && !isRefetching && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {inView && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

function CategoryTitle({
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
          href={action.href}
          variant="outline"
          size="xs"
          shallow={action.shallow}
          compact
        >
          {action.label}
        </Button>
      ))}
    </Group>
  );
}

const useStyles = createStyles(() => ({
  moreActions: {
    width: '100%',
    flex: '1',
  },
}));
