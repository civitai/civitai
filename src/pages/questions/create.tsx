import { QuestionForm } from '~/components/Questions/QuestionForm';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function QuestionCreate() {
  return <QuestionForm />;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.questions)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };

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
