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
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { BuiltInProviderType } from 'next-auth/providers';
import { getCsrfToken, getProviders, signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { EmailLogin } from '~/components/EmailLogin/EmailLogin';
import { SignInError } from '~/components/SignInError/SignInError';
import { SocialButton } from '~/components/Social/SocialButton';

import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { loginRedirectReasons, LoginRedirectReason } from '~/utils/login-helpers';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { trpc } from '~/utils/trpc';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { QS } from '~/utils/qs';

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
  const { code, source } = useReferralsContext();
  const { data: referrer, isLoading: referrerLoading } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: code as string },
    { enabled: !!code }
  );

  const returnUrlWithReferrals =
    code || source
      ? returnUrl.includes('?')
        ? `${returnUrl}&${QS.stringify({ ref_source: source, ref_code: code })}`
        : `${returnUrl}?${QS.stringify({ ref_source: source, ref_code: code })}`
      : returnUrl;

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
        {referrer && (
          <Paper withBorder>
            <Stack spacing="xs" p="md">
              <Text color="dimmed" size="sm">
                You have been referred by
              </Text>
              <CreatorCard user={referrer} />
              <Text size="sm">
                By using signing up with the referral code <Code>{code}</Code> both you and the user
                who referred you will be awarded buzz. This code will be automatically applied
                during your username selection process.
              </Text>
            </Stack>
          </Paper>
        )}
        <Paper radius="md" p="xl" withBorder>
          <Text size="lg" weight={500}>
            Welcome to Civitai, sign in with
          </Text>

          <Stack mb={error ? 'md' : undefined} mt="md">
            {providers
              ? Object.values(providers)
                  .filter((x) => x.id !== 'email')
                  .map((provider) => {
                    return (
                      <SocialButton
                        key={provider.name}
                        provider={provider.id as BuiltInProviderType}
                        onClick={() => signIn(provider.id, { callbackUrl: returnUrlWithReferrals })}
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
    console.log(ctx);
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
  },
});
