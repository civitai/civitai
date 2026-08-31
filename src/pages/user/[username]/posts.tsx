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

const draftSorts = [PostSort.Newest, PostSort.Oldest];

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
  // A moderator sees anything the creator can see of their own. Matches the
  // images and videos tabs; the server authorizes this independently in
  // `post.service.ts` and does not trust the control being rendered.
  const canViewDrafts = selfView || (currentUser?.isModerator ?? false);

  const [section, setSection] = useState<'published' | 'draft'>(
    canViewDrafts ? querySection ?? 'published' : 'published'
  );
  const viewingDraft = section === 'draft';
  const effectiveScheduled = viewingDraft ? query.scheduled ?? true : query.scheduled;
  // Reaction/comment/collected counts are meaningless on unpublished drafts, and those
  // sorts filter on `count > 0` server-side, so a draft feed under them comes back empty.
  const sort = viewingDraft && !draftSorts.includes(querySort) ? PostSort.Newest : querySort;

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
              {canViewDrafts && (
                <FeedContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    const nextSection = section as 'published' | 'draft';
                    setSection(nextSection);
                    replace({
                      section: nextSection,
                      scheduled: undefined,
                      // Carry the sort across the toggle. Only a count sort has to be
                      // dropped, and only into drafts, where it would filter to nothing.
                      sort:
                        nextSection === 'draft' && !draftSorts.includes(querySort)
                          ? undefined
                          : querySort,
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
                    viewingDraft ? draftSorts.map((value) => ({ label: value, value })) : undefined
                  }
                />
                <PostFiltersDropdown
                  query={{ ...query, period, followed, scheduled: effectiveScheduled }}
                  onChange={(filters) => replace(filters)}
                  showScheduled={canViewDrafts}
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
