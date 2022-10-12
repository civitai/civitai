import { Paper, Group, Text, ButtonProps } from '@mantine/core';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { OAuthProviderType } from 'next-auth/providers';
import { getCsrfToken, getProviders, signIn } from 'next-auth/react';
import React, { MouseEventHandler } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { GitHubButton, DiscordButton } from '~/components/SocialButtons/SocialButtons';

const mapProviderSignInButton = {
  github: (props: ButtonProps & { onClick: MouseEventHandler }) => (
    <GitHubButton radius="xl" {...props}>
      Sign In With GitHub
    </GitHubButton>
  ),
  discord: (props: ButtonProps & { onClick: MouseEventHandler }) => (
    <DiscordButton radius="xl" {...props}>
      Sign In With Discord
    </DiscordButton>
  ),
};

export default function Login({
  providers,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <AppLayout>
      <Paper radius="md" p="xl" withBorder>
        <Text size="lg" weight={500}>
          Welcome to Model Share, sign in with
        </Text>

        <Group grow mb="md" mt="md">
          {providers
            ? Object.values(providers).map((provider) => {
                const ProviderButton =
                  mapProviderSignInButton[provider.id as keyof typeof mapProviderSignInButton];

                return (
                  <React.Fragment key={provider.name}>
                    {ProviderButton && <ProviderButton onClick={() => signIn(provider.id)} />}
                  </React.Fragment>
                );
              })
            : null}
        </Group>
      </Paper>
    </AppLayout>
  );
}

type NextAuthProviders = AsyncReturnType<typeof getProviders>;
type NextAuthCsrfToken = AsyncReturnType<typeof getCsrfToken>;
type Props = {
  providers: NextAuthProviders;
  // csrfToken: NextAuthCsrfToken;
};

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const providers = await getProviders();
  // const csrfToken = await getCsrfToken();

  return {
    props: { providers },
  };
};
