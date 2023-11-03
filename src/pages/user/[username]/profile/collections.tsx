import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { Group, Stack } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { constants } from '~/server/common/constants';
import { useState } from 'react';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import ProfileLayout from '~/components/Profile/ProfileLayout';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { SortFilter } from '~/components/Filters';
import { ArticleSort, CollectionSort } from '~/server/common/enums';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MetricTimeframe } from '@prisma/client';
import { postgresSlugify } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { UserDraftArticles } from '~/components/Article/UserDraftArticles';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { useRouter } from 'next/router';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { trpc } from '~/utils/trpc';
import { CollectionsInfinite } from '~/components/Collections/Infinite/CollectionsInfinite';

export function UserProfileCollections() {
  const router = useRouter();
  const { set, ...queryFilters } = useCollectionQueryParams();
  const sort = queryFilters.sort ?? constants.collectionFilterDefaults.sort;

  const username = (router.query.username as string) ?? '';
  const { data: creator } = trpc.user.getCreator.useQuery({ username });

  // currently not showing any content if the username is undefined
  if (!username || !creator) return <NotFound />;

  return (
    <ProfileLayout username={username}>
      <ProfileHeader username={username} />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={4}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs" mt="md">
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
    </ProfileLayout>
  );
}

UserProfileCollections.getLayout = (page: React.ReactElement) => (
  <SidebarLayout>{page}</SidebarLayout>
);

export default UserProfileCollections;
