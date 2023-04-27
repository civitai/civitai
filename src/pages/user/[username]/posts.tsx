import { Group, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { constants } from '~/server/common/constants';
import { PostSort } from '~/server/common/enums';

import { UserProfileLayout } from './';

export default function UserPostsPage() {
  const { set, ...queryFilters } = usePostQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? PostSort.Newest;

  if (!queryFilters.username) return <NotFound />;

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
              <SortFilter
                type="posts"
                value={sort}
                onChange={(sort) => set({ sort: sort as any })}
              />
              <PeriodFilter type="posts" value={period} onChange={(period) => set({ period })} />
            </Group>
            <PostsInfinite filters={{ ...queryFilters, period, sort }} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

UserPostsPage.getLayout = UserProfileLayout;
