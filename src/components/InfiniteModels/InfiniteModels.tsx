import { Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';

import { AmbientModelCard } from '~/components/InfiniteModels/AmbientModelCard';
import { useInfiniteModelsFilters } from '~/components/InfiniteModels/InfiniteModelsFilters';
import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { usernameSchema } from '~/server/schema/user.schema';
import { trpc } from '~/utils/trpc';

type InfiniteModelsProps = {
  columnWidth?: number;
  showHidden?: boolean;
  delayNsfw?: boolean;
};

const filterSchema = z.object({
  query: z.string().optional(),
  user: z.string().optional(),
  username: usernameSchema.optional(),
  tagname: z.string().optional(),
  tag: z.string().optional(),
  favorites: z.preprocess((val) => val === true || val === 'true', z.boolean().optional()),
  hidden: z.preprocess((val) => val === true || val === 'true', z.boolean().optional()),
});

export function InfiniteModels({ columnWidth = 300, delayNsfw = false }: InfiniteModelsProps) {
  const router = useRouter();
  const filters = useInfiniteModelsFilters();
  const result = filterSchema.safeParse(router.query);
  const currentUser = useCurrentUser();
  const queryParams = result.success ? result.data : {};
  const modelId = router.query.model ? Number(router.query.model) : undefined;

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.model.getAll.useInfiniteQuery(
      {
        ...filters,
        ...queryParams,
      },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
      }
    );

  const isAuthenticated = !!currentUser;
  const models = useMemo(
    () => {
      const items = data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [];

      // If current user isn't authenticated make sure they aren't greeted with a blurry wall
      if (delayNsfw && items.length > 0 && !isAuthenticated && items.length <= 100) {
        let toPush = 4;
        while (toPush > 0) {
          let i = 0;
          let item = items[0];
          while (item) {
            item = items[i];
            if (!item || item.nsfw) break;
            i++;
          }
          if (!item) break;
          items.splice(i, 1);
          items.splice(i + 4, 0, item);

          toPush--;
        }
      }

      return items;
    },
    [data, isAuthenticated] //eslint-disable-line
  );

  return (
    <>
      {isLoading ? (
        <Center>
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <MasonryGrid2
          columnWidth={columnWidth}
          data={models}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isRefetching={isRefetching}
          fetchNextPage={fetchNextPage}
          scrollToIndex={(data) => data.findIndex((x) => x.id === modelId)}
          render={AmbientModelCard}
          filters={{
            ...filters,
            ...queryParams,
          }}
        />
      ) : (
        <Stack align="center" py="lg">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text size={32} align="center">
            No results found
          </Text>
          <Text align="center">
            {"Try adjusting your search or filters to find what you're looking for"}
          </Text>
        </Stack>
      )}
    </>
  );
}
