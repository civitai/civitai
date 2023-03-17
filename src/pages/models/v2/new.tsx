import { ModelWizard } from '~/components/Resource/Wizard/ModelWizard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
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

export default function ModelNew() {
  return <ModelWizard />;
}

ModelNew.getLayout = (page: React.ReactElement) => <>{page}</>;
