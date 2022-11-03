import { Container, Paper, Stack, Text } from '@mantine/core';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { BuiltInProviderType } from 'next-auth/providers';
import { getCsrfToken, getProviders, signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import React from 'react';
import { SignInError } from '~/components/SignInError/SignInError';
import { SocialButton } from '~/components/Social/SocialButton';

import { getServerAuthSession } from '~/server/common/get-server-auth-session';

export default function Login({
  providers,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { error, returnUrl = '/' } = router.query as { error: string; returnUrl: string };
  return (
    <Container size="xs">
      <Paper radius="md" p="xl" withBorder>
        <Text size="lg" weight={500}>
          Welcome to Model Share, sign in with
        </Text>

        <Stack mb="md" mt="md">
          {providers
            ? Object.values(providers).map((provider) => {
                return (
                  <SocialButton
                    key={provider.name}
                    provider={provider.id as BuiltInProviderType}
                    onClick={() => signIn(provider.id, { callbackUrl: returnUrl })}
                  />
                );
              })
            : null}
        </Stack>
        {error && (
          <SignInError color="yellow" title="Login Error" mt="lg" variant="outline" error={error} />
        )}
      </Paper>
    </Container>
  );
}

type NextAuthProviders = AsyncReturnType<typeof getProviders>;
type NextAuthCsrfToken = AsyncReturnType<typeof getCsrfToken>;
type Props = {
  providers: NextAuthProviders;
  csrfToken: NextAuthCsrfToken;
};

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getServerAuthSession(ctx);

  if (session) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }

  const providers = await getProviders();
  const csrfToken = await getCsrfToken();

  return {
    props: { providers, csrfToken },
  };
};
