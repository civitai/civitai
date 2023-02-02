import { GetServerSideProps } from 'next';
import { ModelForm } from '~/components/Model/ModelForm/ModelForm';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default function Create() {
  return <ModelForm />;
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
