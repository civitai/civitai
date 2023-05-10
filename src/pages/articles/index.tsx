import { Group, Stack, Title } from '@mantine/core';

import { Announcements } from '~/components/Announcements/Announcements';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategoriesInfinite } from '~/components/Article/Categories/ArticleCategoriesInfinite';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { SortFilter, PeriodFilter, ViewToggle } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showMobile, hideMobile } from '~/libs/sx-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';

export default function ArticlesPage() {
  const currentUser = useCurrentUser();
  const storedView = useFiltersContext((state) => state.articles.view);
  const { view: queryView, ...filters } = useArticleQueryParams();

  const view = queryView ?? storedView;

  return (
    <>
      {/* TODO.articles: update meta title and description accordingly */}
      <Meta
        title={`Civitai${
          !currentUser
            ? ` Articles | Discover AI-Generated Images with Prompts and Resource Details`
            : ''
        }`}
        description="Browse Civitai Articles, featuring AI-generated images along with prompts and resources used for their creation, showcasing the creativity of our talented community."
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
                <SortFilter type="articles" />
              </Group>
              <Group spacing={4}>
                <PeriodFilter type="articles" />
                <ViewToggle type="articles" />
              </Group>
            </Group>
            {view === 'categories' ? (
              <ArticleCategoriesInfinite />
            ) : (
              <>
                <ArticleCategories />
                <ArticlesInfinite filters={filters} />
              </>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
