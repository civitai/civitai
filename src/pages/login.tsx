import {
  Container,
  Paper,
  Stack,
  Text,
  Alert,
  Group,
  ThemeIcon,
  Divider,
  Code,
} from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';
import { BuiltInProviderType } from 'next-auth/providers';
import { getCsrfToken, getProviders, signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { EmailLogin } from '~/components/EmailLogin/EmailLogin';
import { SignInError } from '~/components/SignInError/SignInError';
import { SocialButton } from '~/components/Social/SocialButton';

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { loginRedirectReasons, LoginRedirectReason, trackedReasons } from '~/utils/login-helpers';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { trpc } from '~/utils/trpc';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useEffect, useRef } from 'react';

export default function Login({ providers }: Props) {
  const router = useRouter();
  const {
    error,
    returnUrl = '/',
    reason,
  } = router.query as {
    error: string;
    returnUrl: string;
    reason: LoginRedirectReason;
  };
  const { code, setLoginRedirectReason } = useReferralsContext();
  const { data: referrer } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: code as string },
    { enabled: !!code }
  );
  const observedReason = useRef<string | null>(null);
  const { trackAction } = useTrackEvent();

  const redirectReason = loginRedirectReasons[reason];

  useEffect(() => {
    if (
      setLoginRedirectReason &&
      reason &&
      observedReason?.current !== reason &&
      trackedReasons.includes(reason as any)
    ) {
      // no need to await, worse case this is a noop
      trackAction({
        type: 'LoginRedirect',
        reason: reason as (typeof trackedReasons)[number],
      }).catch(() => undefined);

      // Set the reason in the context so that it can be stored in the DB once the user signs up.
      setLoginRedirectReason(reason);

      // Safeguard to calling this multiple times.
      observedReason.current = reason;
    }
  }, [reason, setLoginRedirectReason]);

  return (
    <>
      <Meta
        title="Sign in to Civitai"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/login`, rel: 'canonical' }]}
      />
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
          {referrer && (
            <Paper withBorder>
              <Stack spacing="xs" p="md">
                <Text color="dimmed" size="sm">
                  You have been referred by
                </Text>
                <CreatorCard user={referrer} withActions={false} />
                <Text size="sm">
                  By signing up with the referral code <Code>{code}</Code> both you and the user who
                  referred you will be awarded{' '}
                  <Text span inline>
                    <CurrencyBadge currency={Currency.BUZZ} unitAmount={500} />
                  </Text>
                  . This code will be automatically applied during your username selection process.
                </Text>
              </Stack>
            </Paper>
          )}
          <Paper radius="md" p="xl" withBorder>
            <Text size="lg" weight={500}>
              Welcome to Civitai, sign in with
            </Text>

            <Stack mt="md">
              {providers
                ? Object.values(providers)
                    .filter((x) => x.id !== 'email')
                    .map((provider) => {
                      return (
                        <SocialButton
                          key={provider.name}
                          provider={provider.id as BuiltInProviderType}
                          onClick={() => {
                            signIn(provider.id, { callbackUrl: returnUrl });
                          }}
                        />
                      );
                    })
                : null}
              <Divider label="Or" labelPosition="center" />
              <EmailLogin />
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
    </>
  );
}

type NextAuthProviders = AsyncReturnType<typeof getProviders>;
type NextAuthCsrfToken = AsyncReturnType<typeof getCsrfToken>;
type Props = {
  providers: NextAuthProviders;
  csrfToken: NextAuthCsrfToken;
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (session) {
      const { callbackUrl, error } = ctx.query;
      const destination = new URL(typeof callbackUrl === 'string' ? callbackUrl : '/');
      if (error) destination.searchParams.set('error', error as string);
      return {
        redirect: {
          destination: destination.toString(),
          permanent: false,
        },
      };
    }

    const providers = await getProviders();
    const csrfToken = await getCsrfToken();

    return {
      props: { providers, csrfToken },
    };
  },
});
