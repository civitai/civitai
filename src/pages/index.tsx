import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import PersonalizedHomepage from '~/pages/home';
import ModelsPage from '~/pages/models';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ssg }) => {
    console.log('REEEEE get server side props index');
    const features = getFeatureFlags({ user: session?.user });
    if (features.alternateHome && ssg) await ssg.homeBlock.getHomeBlocks.prefetch();

    return { props: {} };
  },
});

function Home() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser ? ` | Stable Diffusion models, embeddings, LoRAs and more` : ''
        }`}
        description="Civitai is a platform for Stable Diffusion AI Art models. Browse a collection of thousands of models from a growing number of creators. Join an engaged community in reviewing models and sharing images with prompts to get you started."
      />
      {features.alternateHome ? <PersonalizedHomepage /> : <ModelsPage />}
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
