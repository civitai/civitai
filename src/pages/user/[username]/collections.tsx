import { Box, Center, Group, Loader, Stack, Tabs } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionsInfinite } from '~/components/Collections/Infinite/CollectionsInfinite';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { CollectionSort } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import React, { useMemo } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx, features }) => {
    if (!features?.profileCollections)
      return {
        redirect: {
          destination: `/user/${ctx.query.username}`,
          permanent: false,
        },
      };
  },
});

export default function UserCollectionsPage() {
  const router = useRouter();
  const { set, ...queryFilters } = useCollectionQueryParams();
  const sort = queryFilters.sort ?? constants.collectionFilterDefaults.sort;

  const username = (router.query.username as string) ?? '';
  const { data: creator, isLoading } = trpc.user.getCreator.useQuery(
    { username },
    { enabled: username !== constants.system.user.username }
  );

  // currently not showing any content if the username is undefined
  if (!username || (!creator && !isLoading)) return <NotFound />;

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
                variant="button"
                value={sort}
                onChange={(x) => set({ sort: x as CollectionSort })}
              />
            </Group>
            <CollectionsInfinite
              filters={{ ...queryFilters, sort, userId: creator?.id }}
              enabled={!!creator}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

setPageOptions(UserCollectionsPage, { innerLayout: UserProfileLayout });
