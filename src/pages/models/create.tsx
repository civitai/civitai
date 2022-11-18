import { GetServerSideProps } from 'next';
import { Session } from 'next-auth';
import { ModelForm } from '~/components/Model/ModelForm/ModelForm';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default function Create() {
  return <ModelForm />;
}

type Props = { session: Session };

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getServerAuthSession(ctx);

  if (!session) {
    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return { props: { session } };
};
