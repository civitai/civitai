import { Group, SegmentedControl, SegmentedControlProps, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { UserDraftArticles } from '~/components/Article/UserDraftArticles';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ArticleSort } from '~/server/common/enums';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { UserProfileLayout } from './';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.articles)
      return {
        redirect: {
          destination: `/user/${ctx.query.username}`,
          permanent: false,
        },
      };
  },
});

export default function UserArticlesPage() {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { set, section: querySection, ...queryFilters } = useArticleQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? ArticleSort.Newest;
  const username = (router.query.username as string) ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Tabs.Panel value="/articles">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Group spacing={8}>
              {selfView && (
                <ContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    setSection(section);
                    set({ section });
                  }}
                />
              )}
              {viewingPublished && (
                <>
                  <SortFilter
                    type="articles"
                    value={sort}
                    onChange={(x) => set({ sort: x as ArticleSort })}
                  />
                  <Group spacing="xs" ml="auto">
                    <PeriodFilter
                      type="articles"
                      value={period}
                      onChange={(x) => set({ period: x })}
                      hideMode={selfView}
                    />
                  </Group>
                </>
              )}
            </Group>
            {viewingPublished ? (
              <ArticlesInfinite
                filters={{
                  ...queryFilters,
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
    </Tabs.Panel>
  );
}

function ContentToggle({
  value,
  onChange,
  ...props
}: Omit<SegmentedControlProps, 'value' | 'onChange' | 'data'> & {
  value: 'published' | 'draft';
  onChange: (value: 'published' | 'draft') => void;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={[
        { label: 'Published', value: 'published' },
        { label: 'Draft', value: 'draft' },
      ]}
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

UserArticlesPage.getLayout = UserProfileLayout;
