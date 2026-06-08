import { Box, Group, Stack } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import React, { useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { constants } from '~/server/common/constants';
import { PostSort } from '~/server/common/enums';
import { postgresSlugify } from '~/utils/string-helpers';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { Page } from '~/components/AppLayout/Page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbRead } from '~/server/db/client';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function UserPostsPage() {
  const currentUser = useCurrentUser();
  const {
    replace,
    query: { followed = false, section: querySection, ...query },
  } = usePostQueryParams();
  // const { replace, section: querySection, ...queryFilters } = usePostQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const querySort = query.sort ?? PostSort.Newest;
  const selfView =
    !!currentUser &&
    !!query.username &&
    postgresSlugify(currentUser.username) === postgresSlugify(query.username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingDraft = section === 'draft';
  const effectiveScheduled = viewingDraft ? query.scheduled ?? true : query.scheduled;
  const sort = viewingDraft ? PostSort.Newest : querySort;

  if (!query.username) return <NotFound />;

  return (
    <Box mt="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack gap="xs">
            <Group gap={8} justify="space-between">
              {selfView && (
                <FeedContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    setSection(section as 'published' | 'draft');
                    replace({
                      section: section as 'published' | 'draft',
                      scheduled: undefined,
                      sort: section === 'draft' ? PostSort.Newest : undefined,
                    });
                  }}
                />
              )}
              <Group gap={8} ml="auto" wrap="nowrap">
                <SortFilter
                  type="posts"
                  value={sort}
                  onChange={(x) => replace({ sort: x as PostSort })}
                  options={
                    viewingDraft ? [{ label: PostSort.Newest, value: PostSort.Newest }] : undefined
                  }
                />
                <PostFiltersDropdown
                  query={{ ...query, period, followed, scheduled: effectiveScheduled }}
                  onChange={(filters) => replace(filters)}
                  showScheduled={selfView}
                  size="compact-sm"
                />
              </Group>
            </Group>
            <PostsInfinite
              filters={{
                ...query,
                followed,
                period,
                sort,
                scheduled: effectiveScheduled,
                draftOnly: viewingDraft,
                pending: true,
              }}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

export default Page(UserPostsPage, { getLayout: UserProfileLayout });
