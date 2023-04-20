import { Group, Stack, Tabs } from '@mantine/core';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { constants } from '~/server/common/constants';

import { UserProfileLayout } from './';

export default function UserPostsPage() {
  const filters = usePostQueryParams();

  if (!filters.username) return <NotFound />;

  return (
    <Tabs.Panel value="/posts">
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Group position="apart" spacing={0}>
              <SortFilter type="posts" />
              <PeriodFilter type="posts" />
            </Group>
            <PostsInfinite filters={filters} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

UserPostsPage.getLayout = UserProfileLayout;
