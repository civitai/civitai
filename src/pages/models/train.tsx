import TrainWizard from '~/components/Resource/Wizard/TrainWizard'
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
  return <TrainWizard />;
}

ModelTrainingNew.getLayout = (page: React.ReactElement) => <>{page}</>;
