import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import PersonalizedHomepage from '~/pages/home';
import ModelsPage from '~/pages/models';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.homeBlock.getHomeBlocks.prefetch();
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();
  const { data: homeExcludedTags = [], isLoading: isLoadingExcludedTags } =
    trpc.tag.getHomeExcluded.useQuery(undefined, { trpc: { context: { skipBatch: true } } });

  return features.alternateHome ? (
    <PersonalizedHomepage />
  ) : (
    <FeedLayout>
      <ModelsPage />
    </FeedLayout>
  );
}
