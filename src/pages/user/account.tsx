import { Container, Stack, Title, Text, Card } from '@mantine/core';
import { GetServerSideProps } from 'next';
import { getProviders } from 'next-auth/react';
import React from 'react';

import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

import { Meta } from '~/components/Meta/Meta';

import { env } from '~/env/server.mjs';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';

export default function Account({ providers, isDev = false }: Props) {
  return (
    <>
      <Meta title="Manage your Account - Civitai" />

      <Container p={0} size="xs">
        <Stack>
          <Stack spacing={0}>
            <Title order={1}>Manage Account</Title>
            <Text color="dimmed" size="sm">
              Take a moment to review your account information and preferences to personalize your
              experience on the site
            </Text>
          </Stack>
          <ProfileCard />
          <SettingsCard />
          <AccountsCard providers={providers} />
          {isDev && <ApiKeysCard />}
        </Stack>
      </Container>
    </>
  );
}

type Props = {
  providers: AsyncReturnType<typeof getProviders>;
  isDev: boolean;
};

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const session = await getServerAuthSession(context);

  if (!session?.user)
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };

  const providers = await getProviders();
  const ssg = await getServerProxySSGHelpers(context);
  await ssg.account.getAll.prefetch();

  return {
    props: {
      trpcState: ssg.dehydrate(),
      providers,
      isDev: env.NODE_ENV === 'development', // TODO: Remove this once API Keys feature is complete
    },
  };
};
