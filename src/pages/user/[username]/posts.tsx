import { Group, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { constants } from '~/server/common/constants';
import { PostSort } from '~/server/common/enums';
import { postgresSlugify } from '~/utils/string-helpers';

import { UserProfileLayout } from './';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';

export default function UserPostsPage() {
  const currentUser = useCurrentUser();
  const { set, section: querySection, ...queryFilters } = usePostQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? PostSort.Newest;
  const selfView =
    !!currentUser &&
    !!queryFilters.username &&
    postgresSlugify(currentUser.username) === postgresSlugify(queryFilters.username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingDraft = section === 'draft';

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
            <Group spacing={8}>
              {selfView && (
                <FeedContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    setSection(section);
                    set({ section });
                  }}
                />
              )}
              <Group spacing={8} position="apart" sx={{ flexGrow: 1 }}>
                <SortFilter
                  type="posts"
                  value={sort}
                  onChange={(sort) => set({ sort: sort as any })}
                />
                <PeriodFilter type="posts" value={period} onChange={(period) => set({ period })} />
              </Group>
            </Group>
            <PostsInfinite filters={{ ...queryFilters, period, sort, draftOnly: viewingDraft }} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

UserPostsPage.getLayout = UserProfileLayout;
