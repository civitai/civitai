import { Center, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import TrainWizard from '~/components/Training/Wizard/TrainWizard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session) {
      return {
        redirect: {
          destination: '/login',
          permanent: false,
        },
      };
    }

    if (session.user?.bannedAt)
      return {
        redirect: { destination: '/', permanent: false },
      };

    return { props: { session } };
  },
});

function ModelTrainingNew() {
  // With the Training Studio on, training starts there — the old wizard stays reachable only by
  // toggling the studio off. `replace` so Back doesn't bounce through this page again.
  const features = useFeatureFlags();
  const router = useRouter();
  useEffect(() => {
    if (features.trainingStudioUi) void router.replace('/training-studio?view=new');
  }, [features.trainingStudioUi, router]);
  if (features.trainingStudioUi)
    return (
      <Center h="60vh">
        <Loader />
      </Center>
    );

  return <TrainWizard />;
}

export default Page(ModelTrainingNew, { features: (features) => features.imageTraining });
