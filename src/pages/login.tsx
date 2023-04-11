import { Container, Paper, Stack, Text, Alert, Group, ThemeIcon, Divider } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { BuiltInProviderType } from 'next-auth/providers';
import {
  ClientSafeProvider,
  getCsrfToken,
  getProviders,
  LiteralUnion,
  signIn,
} from 'next-auth/react';
import { useRouter } from 'next/router';
import { EmailLogin } from '~/components/EmailLogin/EmailLogin';
import { EthereumLogin } from '~/components/EthereumLogin/EthereumLogin';
import { SignInError } from '~/components/SignInError/SignInError';
import { SocialButton } from '~/components/Social/SocialButton';

import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { filterProviders } from '~/utils/account';
import { loginRedirectReasons, LoginRedirectReason } from '~/utils/login-helpers';

export default function Login({
  providers,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const {
    error,
    returnUrl = '/',
    reason,
  } = router.query as { error: string; returnUrl: string; reason: LoginRedirectReason };

  const redirectReason = loginRedirectReasons[reason];

  return (
    <Container size="xs">
      <Stack>
        {!!redirectReason && (
          <Alert color="yellow">
            <Group position="center" spacing="xs" noWrap align="flex-start">
              <ThemeIcon color="yellow">
                <IconExclamationMark />
              </ThemeIcon>
              <Text size="md">{redirectReason}</Text>
            </Group>
          </Alert>
        )}
        <Paper radius="md" p="xl" withBorder>
          <Text size="lg" weight={500}>
            Welcome to Agentswap, sign in with
          </Text>

          <Stack mb={error ? 'md' : undefined} mt="md">
            {providers
              ? Object.values(providers).map((provider) => {
                  if (provider.type === 'email') return null;
                  if (provider.type === 'credentials') return null;
                  return (
                    <SocialButton
                      key={provider.name}
                      provider={provider.id as BuiltInProviderType}
                      onClick={() => signIn(provider.id, { callbackUrl: returnUrl })}
                    />
                  );
                })
              : null}
            <EthereumLogin callbackUrl={returnUrl} />
            {false && (
              <>
                <Divider label="Or" labelPosition="center" />
                <EmailLogin />
              </>
            )}
          </Stack>
          {error && (
            <SignInError
              color="yellow"
              title="Login Error"
              mt="lg"
              variant="outline"
              error={error}
            />
          )}
        </Paper>
      </Stack>
    </Container>
  );
}

type NextAuthProviders = Record<
  LiteralUnion<BuiltInProviderType | 'ethereum', string>,
  ClientSafeProvider
> | null;
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
    props: { providers: filterProviders(providers), csrfToken },
  };
};
