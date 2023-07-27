import { Center, Group, Loader, Stack, Tabs } from '@mantine/core';
import { CollectionReadConfiguration } from '@prisma/client';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import {
  useCollectionQueryParams,
  useQueryCollections,
} from '~/components/Collections/collection.utils';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { CollectionSort } from '~/server/common/enums';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { UserProfileLayout } from './';
import { NoContent } from '~/components/NoContent/NoContent';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.collections)
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

  const { collections, isLoading } = useQueryCollections(
    {
      ...queryFilters,
      userId: creator?.id,
      sort,
      privacy: [CollectionReadConfiguration.Private],
      withItems: true,
    },
    { enabled: !!creator }
  );

  // currently not showing any content if the username is undefined
  if (!username || !creator) return <NotFound />;

  return (
    <Tabs.Panel value="/collections">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
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
            {isLoading ? (
              <Center py="xl">
                <Loader />
              </Center>
            ) : !!collections?.length ? (
              collections.map((collection) => collection.name)
            ) : (
              <NoContent message="There are no matching collections for this user" />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

UserCollectionsPage.getLayout = UserProfileLayout;
