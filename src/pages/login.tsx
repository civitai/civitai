import { ButtonProps, Container, Paper, Stack, Text } from '@mantine/core';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { getCsrfToken, getProviders, getSession, signIn } from 'next-auth/react';
import React, { MouseEventHandler } from 'react';
import {
  DiscordButton,
  GitHubButton,
  GoogleButton,
} from '~/components/SocialButtons/SocialButtons';

const mapProviderSignInButton = {
  github: (props: ButtonProps & { onClick: MouseEventHandler }) => (
    <GitHubButton radius="xl" {...props}>
      GitHub
    </GitHubButton>
  ),
  discord: (props: ButtonProps & { onClick: MouseEventHandler }) => (
    <DiscordButton radius="xl" {...props}>
      Discord
    </DiscordButton>
  ),
  google: (props: ButtonProps & { onClick: MouseEventHandler }) => (
    <GoogleButton radius="xl" {...props}>
      Google
    </GoogleButton>
  ),
};

export default function Login({
  providers,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <Container size="xs">
      <Paper radius="md" p="xl" withBorder>
        <Text size="lg" weight={500}>
          Welcome to Model Share, sign in with
        </Text>

        <Stack mb="md" mt="md">
          {providers
            ? Object.values(providers).map((provider) => {
                const ProviderButton =
                  mapProviderSignInButton[provider.id as keyof typeof mapProviderSignInButton];

                return (
                  <React.Fragment key={provider.name}>
                    <ProviderButton onClick={() => signIn(provider.id, { callbackUrl: '/' })} />
                  </React.Fragment>
                );
              })
            : null}
        </Stack>
      </Paper>
    </Container>
  );
}

type NextAuthCsrfToken = AsyncReturnType<typeof getCsrfToken>;
type Props = {
  providers: NextAuthProviders;
  csrfToken: NextAuthCsrfToken;
};

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const session = await getSession();

  if (!session) {
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
