import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { SemanticImageSearch } from '~/components/SemanticSearch/SemanticImageSearch';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session }) => {
    if (!session || !features?.semanticImageSearch) return { notFound: true };
  },
});

export default Page(
  function () {
    return (
      <>
        <Meta title="Semantic Image Search | Civitai" deIndex />
        <MasonryContainer className="min-h-full">
          <SemanticImageSearch />
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: FeedLayout }
);
