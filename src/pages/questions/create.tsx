import { GetServerSideProps } from 'next';
import { QuestionForm } from '~/components/Questions/QuestionForm';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default function QuestionCreate() {
  return <QuestionForm />;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerAuthSession(ctx);

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
};
