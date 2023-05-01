import { Container, Group, Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { PostCategoriesInfinite } from '~/components/Post/Categories/PostCategoriesInfinite';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';

export default function PostsPage() {
  const currentUser = useCurrentUser();
  const storedView = useFiltersContext((state) => state.posts.view);
  const { view: queryView, ...filters } = usePostQueryParams();

  const view = queryView ?? storedView;
  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser ? ` Posts | Explore Community-Created Content with Custom AI Resources` : ''
        }`}
        description="Discover engaging posts from our growing community on Civitai, featuring unique and creative content generated with custom Stable Diffusion AI resources crafted by talented community members."
      />
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
    </>
  );
}
