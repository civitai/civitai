import { Group, Stack, createStyles, useMantineTheme } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { SortFilter, ViewToggle } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { PostCategoriesInfinite } from '~/components/Post/Categories/PostCategoriesInfinite';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { containerQuery } from '~/utils/mantine-css-helpers';

const useStyles = createStyles((theme) => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function PostsPage() {
  const { classes } = useStyles();
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const storedView = useFiltersContext((state) => state.posts.view);
  const { query } = usePostQueryParams();

  const view = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS ? query.view ?? storedView : 'feed';
  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser ? ` Posts | Explore Community-Created Content with Custom AI Resources` : ''
        }`}
        description="Discover engaging posts from our growing community on Civitai, featuring unique and creative content generated with custom Stable Diffusion AI resources crafted by talented community members."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/posts`, rel: 'canonical' }]}
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
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />

            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter type="posts" variant="button" />
                <PostFiltersDropdown />
                <ViewToggle
                  type="posts"
                  color="gray"
                  radius="xl"
                  size={36}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                />
              </Group>
            </Group>
            <IsClient>
              {view === 'categories' ? (
                <PostCategoriesInfinite filters={query} />
              ) : (
                <>
                  <PostCategories />
                  <PostsInfinite filters={query} showEof />
                </>
              )}
            </IsClient>
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
