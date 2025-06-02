import { Box, Center, Group, Loader, Stack } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionsInfinite } from '~/components/Collections/Infinite/CollectionsInfinite';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import type { CollectionSort } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import React from 'react';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { Page } from '~/components/AppLayout/Page';
import { dbRead } from '~/server/db/client';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx, features }) => {
    const username = ctx.query.username as string;
    if (!features?.profileCollections)
      return {
        redirect: { destination: `/user/${username}`, permanent: false },
      };

    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

function UserCollectionsPage() {
  const router = useRouter();
  const { set, ...queryFilters } = useCollectionQueryParams();
  const sort = queryFilters.sort ?? constants.collectionFilterDefaults.sort;

  const username = (router.query.username as string) ?? '';
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: username !== constants.system.user.username }
  );

  // currently not showing any content if the username is undefined
  if (!username || (!user && !isLoading)) return <NotFound />;

  if (isLoading) {
    return (
      <Box mt="md">
        <Center>
          <Loader />
        </Center>
      </Box>
    );
  }

  return (
    <Box mt="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack spacing="xs">
            <Group spacing={8} position="right">
              <SortFilter
                type="collections"
                value={sort}
                onChange={(x) => set({ sort: x as CollectionSort })}
              />
            </Group>
            <CollectionsInfinite filters={{ ...queryFilters, sort, userId: user.id }} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

export default Page(UserCollectionsPage, { getLayout: UserProfileLayout });
