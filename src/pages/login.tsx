import {
  Alert,
  Code,
  Container,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconExclamationMark } from '@tabler/icons-react';
import { BuiltInProviderType } from 'next-auth/providers';
import { getCsrfToken, getProviders, signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EmailLogin } from '~/components/EmailLogin/EmailLogin';
import { Meta } from '~/components/Meta/Meta';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { SignInError } from '~/components/SignInError/SignInError';
import { SocialButton } from '~/components/Social/SocialButton';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { env } from '~/env/client.mjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { LoginRedirectReason, loginRedirectReasons, trackedReasons } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

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
                <CreatorCardV2 user={referrer} withActions={false} />
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
              <EmailLogin returnUrl={returnUrl} />
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
      const { callbackUrl, error, reason } = ctx.query;
      if (reason !== 'switch-accounts') {
        const destinationURL = new URL(
          typeof callbackUrl === 'string' ? callbackUrl : '/',
          getBaseUrl()
        );
        if (error) destinationURL.searchParams.set('error', error as string);
        const destination = `${destinationURL.pathname}${destinationURL.search}${destinationURL.hash}`;

        return {
          redirect: {
            destination,
            permanent: false,
          },
        };
      }
    }

    const providers = await getProviders();
    const csrfToken = await getCsrfToken();

    return {
      props: { providers, csrfToken },
    };
  },
});
