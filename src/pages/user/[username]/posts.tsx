import { Box, Group, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import React, { useMemo, useState } from 'react';

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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

export default function UserPostsPage() {
  const currentUser = useCurrentUser();
  const {
    replace,
    query: { followed = undefined, section: querySection, ...query },
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
  const features = useFeatureFlags();

  const Wrapper = useMemo(
    () =>
      function Wrapper({ children }: { children: React.ReactNode }) {
        return features.profileOverhaul ? (
          <Box mt="md">{children}</Box>
        ) : (
          <Tabs.Panel value="/posts">{children}</Tabs.Panel>
        );
      },
    [features.profileOverhaul]
  );

  if (!query.username) return <NotFound />;

  return (
    <Wrapper>
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
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
              <Group spacing={8} ml="auto" noWrap>
                <SortFilter
                  type="posts"
                  variant="button"
                  value={sort}
                  onChange={(x) => replace({ sort: x as PostSort })}
                />
                <PostFiltersDropdown
                  query={{ ...query, period, followed }}
                  onChange={(filters) => replace(filters)}
                  size="sm"
                  compact
                />
              </Group>
            </Group>
            <PostsInfinite
              filters={{ ...query, followed, period, sort, draftOnly: viewingDraft, pending: true }}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Wrapper>
  );
}

setPageOptions(UserPostsPage, { innerLayout: UserProfileLayout });
