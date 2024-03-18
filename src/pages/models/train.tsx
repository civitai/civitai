import { Center } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
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

export default function ModelTrainingNew() {
  const features = useFeatureFlags();
  return features.imageTraining ? (
    <TrainWizard />
  ) : (
    <Center>
      <NotFound />
    </Center>
  );
}
