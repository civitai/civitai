import { Stack, Title } from '@mantine/core';

import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';

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

export default function ArticlesPage() {
  const { query } = useArticleQueryParams();

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
        <MasonryContainer>
          <Stack spacing="xs">
            <Announcements
              sx={() => ({
                marginBottom: -35,
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            {query.favorites && <Title>Your Bookmarked Articles</Title>}
            <ArticleCategories />
            <ArticlesInfinite filters={query} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}

setPageOptions(ArticlesPage, { innerLayout: FeedLayout });
