import { Button, Container, Group, Stack, Stepper, Title } from '@mantine/core';
import { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { Wizard } from '~/components/Resource/Wizard/Wizard';
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
  const router = useRouter();

  return (
    <Container size="sm">
      <Stack py="xl">
        <Wizard>
          <Stepper.Step label="Create your model">
            <Title order={4}></Title>
            <ModelUpsertForm />
          </Stepper.Step>
          <Stepper.Step label="Add versions">
            <Title order={4}>Version list goes here</Title>
          </Stepper.Step>
          <Stepper.Step label="Upload files">
            <Title order={4}>File list goes here</Title>
          </Stepper.Step>

          <Stepper.Completed>
            Completed, click back button to get to previous step
          </Stepper.Completed>
        </Wizard>
      </Stack>
    </Container>
  );
}

ModelNew.getLayout = (page: any) => <>{page}</>;
