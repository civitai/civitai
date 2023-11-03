import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { Group, Stack } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { constants } from '~/server/common/constants';
import { useState } from 'react';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import ProfileLayout from '~/components/Profile/ProfileLayout';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { SortFilter } from '~/components/Filters';
import { ArticleSort } from '~/server/common/enums';
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

export function UserProfileArticles() {
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
    <ProfileLayout username={username}>
      <ProfileHeader username={username} />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs" mt="md">
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
                    variant="button"
                    value={sort}
                    onChange={(x) => replace({ sort: x as ArticleSort })}
                  />
                  <ArticleFiltersDropdown
                    query={{ ...query, followed }}
                    onChange={(filters) => replace(filters)}
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
                }}
              />
            ) : (
              <UserDraftArticles />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </ProfileLayout>
  );
}

UserProfileArticles.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileArticles;
