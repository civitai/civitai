import { Container, Group, Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PostCategoriesInfinite } from '~/components/CategoryList/PostCategoriesInfinite';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';

export default function PostsPage() {
  const features = useFeatureFlags();
  const storedView = useFiltersContext((state) => state.posts.view);
  const { view: queryView, ...filters } = usePostQueryParams();
  // return <NotFound />;
  if (!features.posts) return <NotFound />;

  const view = queryView ?? storedView;
  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.image}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer fluid>
        <Stack spacing="xs">
          <Announcements
            sx={(theme) => ({
              marginBottom: -35,
              [theme.fn.smallerThan('md')]: {
                marginBottom: -5,
              },
            })}
          />
          <HomeContentToggle sx={showMobile} />
          <Group position="apart" spacing={0}>
            <Group>
              <HomeContentToggle sx={hideMobile} />
              <SortFilter type="posts" />
            </Group>
            <Group spacing={4}>
              <PeriodFilter type="posts" />
              <ViewToggle type="posts" />
            </Group>
          </Group>
          {view === 'categories' ? (
            <PostCategoriesInfinite filters={filters} />
          ) : (
            <>
              <PostCategories />
              <PostsInfinite filters={filters} />
            </>
          )}
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
