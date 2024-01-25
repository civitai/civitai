import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import PersonalizedHomepage from '~/pages/home';
import ModelsPage from '~/pages/models';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ssg, features }) => {
    if (features?.alternateHome && ssg) await ssg.homeBlock.getHomeBlocks.prefetch();

    return { props: {} };
  },
});

function Home() {
  const features = useFeatureFlags();

  return features.alternateHome ? (
    <PersonalizedHomepage />
  ) : (
    <FeedLayout>
      <ModelsPage />
    </FeedLayout>
  );
}

export default Home;
