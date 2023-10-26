import { createStyles, Group, Stack, Title, useMantineTheme } from '@mantine/core';

import { Announcements } from '~/components/Announcements/Announcements';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategoriesInfinite } from '~/components/Article/Categories/ArticleCategoriesInfinite';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { SortFilter, ViewToggle } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.articles)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };
  },
});

const useStyles = createStyles((theme) => ({
  filtersWrapper: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function ArticlesPage() {
  const { classes } = useStyles();
  const theme = useMantineTheme();
  const features = useFeatureFlags();
  const storedView = useFiltersContext((state) => state.articles.view);
  const { query } = useArticleQueryParams();

  const view = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS ? query.view ?? storedView : false;

  return (
    <>
      <Meta
        title="Civitai Articles | Community Guides and Insights"
        description="Learn, innovate, and draw inspiration from generative AI articles written by the Civitai community"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/articles`, rel: 'canonical' }]}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          {query.favorites && <Title>Your Bookmarked Articles</Title>}
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [theme.fn.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />

            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter type="articles" variant="button" />
                <ArticleFiltersDropdown />
                <ViewToggle
                  type="articles"
                  color="gray"
                  radius="xl"
                  size={36}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                />
              </Group>
            </Group>
            {view === 'categories' ? (
              <ArticleCategoriesInfinite filters={query} />
            ) : (
              <>
                <ArticleCategories />
                <ArticlesInfinite filters={query} />
              </>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
