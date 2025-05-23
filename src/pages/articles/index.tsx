import { Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
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

function ArticlesPage() {
  const { query } = useArticleQueryParams();

  return (
    <>
      <Meta
        title="Civitai Articles | Community Guides and Insights"
        description="Learn, innovate, and draw inspiration from generative AI articles written by the Civitai community"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/articles`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        <Stack gap="xs">
          {query.favorites && <Title>Your Bookmarked Articles</Title>}
          <ArticleCategories />
          <ArticlesInfinite filters={query} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ArticlesPage, { InnerLayout: FeedLayout, announcements: true });
