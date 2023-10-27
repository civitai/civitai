import { Group, Stack, Tabs } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionsInfinite } from '~/components/Collections/Infinite/CollectionsInfinite';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { CollectionSort } from '~/server/common/enums';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { UserProfileLayout } from './';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.profileCollections)
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
  const { data: creator } = trpc.user.getCreator.useQuery({ username });

  // currently not showing any content if the username is undefined
  if (!username || !creator) return <NotFound />;

  return (
    <Tabs.Panel value="/collections">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={4}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Group spacing={8}>
              <SortFilter
                type="collections"
                value={sort}
                onChange={(x) => set({ sort: x as CollectionSort })}
              />
            </Group>
            <CollectionsInfinite
              filters={{ ...queryFilters, sort, userId: creator.id }}
              enabled={!!creator}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

UserCollectionsPage.getLayout = UserProfileLayout;
