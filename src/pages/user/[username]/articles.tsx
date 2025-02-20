import { Box, Group, Stack } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { useRouter } from 'next/router';
import React, { useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { UserDraftArticles } from '~/components/Article/UserDraftArticles';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ArticleSort } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { Page } from '~/components/AppLayout/Page';
import { dbRead } from '~/server/db/client';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx, features }) => {
    const username = ctx.query.username as string;
    if (!features?.articles)
      return {
        redirect: {
          destination: `/user/${username}`,
          permanent: false,
        },
      };

    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

function UserArticlesPage() {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const {
    replace,
    query: { followed = undefined, ...query },
  } = useArticleQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ArticleSort.Newest;
  const username = (router.query.username as string) ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? query.section ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';
  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Box mt="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack spacing="xs">
            <Group spacing={8} position="apart">
              {selfView && (
                <FeedContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    setSection(section);
                    replace({ section });
                  }}
                />
              )}
              {viewingPublished && (
                <Group spacing={8} ml="auto" noWrap>
                  <SortFilter
                    type="articles"
                    value={sort}
                    onChange={(x) => replace({ sort: x as ArticleSort })}
                  />
                  <ArticleFiltersDropdown
                    query={{ ...query, period, followed }}
                    onChange={(filters) => replace(filters)}
                    size="sm"
                    compact
                  />
                </Group>
              )}
            </Group>
            {viewingPublished ? (
              <ArticlesInfinite
                filters={{
                  ...query,
                  sort,
                  period,
                  includeDrafts: !!currentUser?.isModerator,
                  pending: true,
                }}
                showEmptyCta={selfView}
              />
            ) : (
              <UserDraftArticles />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

export default Page(UserArticlesPage, { getLayout: UserProfileLayout });
