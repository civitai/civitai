import { NotFound } from '~/components/AppLayout/NotFound';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getStripeConnectOnboardingLink } from '../../../server/services/user-stripe-connect.service';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ features, session }) => {
    if (!features?.creatorsProgram || !session?.user) {
      return {
        redirect: {
          destination: '/404',
          permanent: false,
        },
      };
    }

    try {
      const accountLink = await getStripeConnectOnboardingLink({ userId: session?.user?.id });

      return {
        redirect: {
          destination: accountLink.url,
          permanent: false,
        },
      };
    } catch {
      return {
        redirect: {
          permanent: false,
          destination: '/404',
        },
      };
    }
  },
});

export default function Onboard() {
  return <NotFound />;
}
