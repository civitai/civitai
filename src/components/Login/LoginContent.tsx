import { Alert, Button, Code, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconExclamationMark, IconMail } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import type { BuiltInProviderType } from 'next-auth/providers/index';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { CreatorCardSimple } from '~/components/CreatorCard/CreatorCardSimple';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EmailLogin } from '~/components/EmailLogin/EmailLogin';
import { IconCivitai } from '~/components/SVG/IconCivitai';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { SignInError } from '~/components/SignInError/SignInError';
import { providers, SocialButton } from '~/components/Social/SocialButton';
import { useTrackEvent } from '~/components/TrackView/track.utils';

import { Currency } from '~/shared/utils/prisma/enums';
import { useAppContext, useServerDomains } from '~/providers/AppProvider';
import { handleSignIn } from '~/utils/auth-helpers';
import { setCookie } from '~/utils/cookies-helpers';
import type { LoginRedirectReason } from '~/utils/login-helpers';
import { loginRedirectReasons, trackedReasons } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export function LoginContent(args: {
  returnUrl?: string;
  message?: React.ReactNode;
  reason?: LoginRedirectReason;
}) {
  const router = useRouter();
  const query = router.query as {
    error?: string;
    returnUrl?: string;
    reason?: LoginRedirectReason;
  };

  const [status, setStatus] = useState<'idle' | 'loading' | 'submitted'>('idle');
  const { code } = useReferralsContext();
  const { data: referrer } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: code! },
    { enabled: !!code }
  );

  const returnUrl = args.returnUrl ?? query.returnUrl ?? '/';
  const reason = args.reason ?? query.reason;
  const message = reason ? loginRedirectReasons[reason] : args.message;

  // Show "Login with [green domain]" on any domain that isn't green (.com).
  // Skip if currentHost isn't known — encoding an empty host into the
  // returnUrl would produce `https:///...` and break the post-login redirect.
  const greenDomain = useServerDomains().green;
  const {
    domain: domainFlags,
    host: currentHost,
    serverDomains: serverDomainConfigs,
    availableOAuthProviders,
  } = useAppContext();
  const isOnGreen = domainFlags.green;
  const civitaiLoginHref =
    !isOnGreen && currentHost
      ? `//${greenDomain}/login?returnUrl=${encodeURIComponent(
          `https://${currentHost}${returnUrl}?sync-account=green`
        )}`
      : undefined;

  // Detect alias-host case: current host is registered for a color but is NOT
  // that color's primary. On alias hosts we suppress every login surface
  // except the green-bounce button so all auth happens on the canonical
  // primary and syncs back via sync-account.
  const isOnAlias = (() => {
    if (!currentHost) return false;
    const normalized = currentHost.toLowerCase();
    for (const cfg of Object.values(serverDomainConfigs)) {
      if (!cfg) continue;
      if (cfg.primary === normalized) return false;
      if (cfg.aliases.includes(normalized)) return true;
    }
    return false;
  })();

  // Filter the static provider list down to providers with credentials
  // configured for the active host (computed server-side per request).
  // On alias hosts, suppress entirely so the green-bounce button is the
  // only login path.
  const availableProviders = isOnAlias
    ? []
    : providers.filter((p) => availableOAuthProviders.includes(p.id));

  useEffect(() => {
    if (reason) {
      // Set the reason so that it can be stored in the DB once the user signs up.
      setCookie('ref_login_redirect_reason', reason, dayjs().add(5, 'day').toDate());
    }
  }, [reason]);

  const observedReason = useRef<string | null>(null);
  const { trackAction } = useTrackEvent();

  useEffect(() => {
    if (reason && observedReason?.current !== reason && trackedReasons.includes(reason as any)) {
      // no need to await, worse case this is a noop
      trackAction({
        type: 'LoginRedirect',
        reason: reason as (typeof trackedReasons)[number],
      }).catch(() => undefined);

      // Safeguard to calling this multiple times.
      observedReason.current = reason;
    }
  }, [reason]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-center">
        <Logo className="max-h-10" accentColor={!isOnGreen ? '#e03131' : undefined} />
      </div>
      <Title order={1} className="text-center text-xl font-bold">
        Sign Up or Log In
      </Title>
      {message && (
        <Alert
          py="sm"
          color="yellow"
          icon={
            <ThemeIcon color="yellow">
              <IconExclamationMark />
            </ThemeIcon>
          }
        >
          {message}
        </Alert>
      )}
      {referrer && (
        <Paper withBorder className="p-3">
          <div className="flex flex-col gap-2">
            <Text c="dimmed" size="sm">
              You have been referred by
            </Text>
            <CreatorCardSimple user={referrer} />
            <Text size="sm">
              By signing up with the referral code <Code>{code}</Code> both you and the user who
              referred you will be awarded{' '}
              <Text span inline>
                <CurrencyBadge currency={Currency.BUZZ} unitAmount={500} />
              </Text>
              . This code will be automatically applied during your username selection process.
            </Text>
          </div>
        </Paper>
      )}
      {status !== 'submitted' ? (
        <div className="flex flex-col gap-3">
          {civitaiLoginHref && (
            <Button
              component="a"
              href={civitaiLoginHref}
              size="md"
              leftSection={<IconCivitai size={20} />}
              className="bg-[#228BE6] hover:bg-[#1C7ED6]"
            >
              {greenDomain}
            </Button>
          )}
          {availableProviders.map((provider) => (
            <SocialButton
              key={provider.name}
              size="md"
              provider={provider.id as BuiltInProviderType}
              onClick={() => {
                handleSignIn(provider.id, returnUrl, {
                  // When adding a second account, ask the provider to show its
                  // account chooser so users can pick a different identity on
                  // the same provider (e.g. a second Google account).
                  forceAccountSelection: reason === 'switch-accounts',
                });
              }}
            />
          ))}
          {!isOnAlias && (
            <>
              <Text className="py-2 text-center text-sm font-semibold">Or continue with Email</Text>
              <EmailLogin
                returnUrl={returnUrl}
                size="md"
                status={status}
                onStatusChange={setStatus}
              />
            </>
          )}
        </div>
      ) : (
        <Alert
          icon={
            <ThemeIcon>
              <IconMail size={18} />
            </ThemeIcon>
          }
          classNames={{
            wrapper: 'items-center',
          }}
        >
          <Stack gap={0}>
            <Text
              size="md"
              // style={{ lineHeight: 1.1 }}
            >{`Check your email for a special login link`}</Text>
            <Text size="xs" c="dimmed">
              Be sure to check your spam...
            </Text>
          </Stack>
        </Alert>
      )}

      {query.error && (
        <SignInError color="yellow" title="Login Error" variant="outline" error={query.error} />
      )}
    </div>
  );
}

function Logo({
  className,
  accentColor = '#1971c2',
}: {
  className?: string;
  accentColor?: string;
}) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 22.7" className={className}>
      <g>
        <path
          className="fill-[#222] dark:fill-white"
          d="M20.8,1.7H3.7L1.5,4.1v15l2.3,2.3h17.1v-5.2H6.7V7h14.1V1.7z"
        />
        <path
          className="fill-[#222] dark:fill-white"
          d="M76.1,1.7H56.6V7h7.2v14.3H69V7h7C76,7,76.1,1.7,76.1,1.7z M23.2,1.8v19.5h5.2V1.8C28.4,1.8,23.2,1.8,23.2,1.8z M30.8,1.8
      v19.5h7.6l8.3-8.3V1.8h-5.2v8.3l-5.4,6V1.8C36.1,1.8,30.8,1.8,30.8,1.8z M49.1,1.8v19.5h5.2V1.8C54.3,1.8,49.1,1.8,49.1,1.8z"
        />
        <path
          fill={accentColor}
          d="M100.3,1.8v19.5h5.2V1.8H100.3z M95.6,1.8H80.8l-2.3,2.3v17.2h5.2v-7.1h8.9v7.1h5.2V4.1C97.8,4.1,95.6,1.8,95.6,1.8z
      M92.7,8.9h-8.9V7h8.9V8.9z"
        />
        <path fill={accentColor} d="M46.7,16.2v5.1h-5.1" />
      </g>
    </svg>
  );
}
