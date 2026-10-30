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
  // A `modelId` is an existing classic-trainer draft or run, which the studio cannot open, so it
  // stays in this wizard. `replace` so Back doesn't bounce through this page again.
  const features = useFeatureFlags();
  const router = useRouter();
  const startsInStudio = features.trainingStudioUi && !router.query.modelId;
  useEffect(() => {
    if (startsInStudio) void router.replace('/training-studio?view=new');
  }, [startsInStudio, router]);
  if (startsInStudio)
    return (
      <Center h="60vh">
        <Loader />
      </Center>
    );

  return <TrainWizard />;
}

export default Page(ModelTrainingNew, { features: (features) => features.imageTraining });
