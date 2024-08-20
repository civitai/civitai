import { NotFound } from '~/components/AppLayout/NotFound';
import { QuestionForm } from '~/components/Questions/QuestionForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function QuestionCreate() {
  const currentUser = useCurrentUser();
  if (!currentUser?.isModerator) return <NotFound />;

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
