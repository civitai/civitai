import { Container } from '@mantine/core';
import { GetServerSideProps } from 'next';

import { ModelWizard } from '~/components/Resource/Wizard/ModelWizard';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

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

export default function ModelNew() {
  return (
    <Container size="sm">
      <ModelWizard />
    </Container>
  );
}

ModelNew.getLayout = (page: any) => <>{page}</>;
