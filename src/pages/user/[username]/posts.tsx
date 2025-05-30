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
  resolver: async ({ ctx }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
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
  const sort = query.sort ?? PostSort.Newest;
  const selfView =
    !!currentUser &&
    !!query.username &&
    postgresSlugify(currentUser.username) === postgresSlugify(query.username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingDraft = section === 'draft';

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
                    replace({ section: section as 'published' | 'draft' });
                  }}
                />
              )}
              <Group gap={8} ml="auto" wrap="nowrap">
                <SortFilter
                  type="posts"
                  value={sort}
                  onChange={(x) => replace({ sort: x as PostSort })}
                />
                <PostFiltersDropdown
                  query={{ ...query, period, followed }}
                  onChange={(filters) => replace(filters)}
                  size="compact-sm"
                />
              </Group>
            </Group>
            <PostsInfinite
              filters={{ ...query, followed, period, sort, draftOnly: viewingDraft, pending: true }}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

export default Page(UserPostsPage, { getLayout: UserProfileLayout });
