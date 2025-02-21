import { getProviders } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { LoginRedirectReason, loginRedirectReasons, trackedReasons } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';
import { TwCard } from '~/components/TwCard/TwCard';
import { LoginContent } from '~/components/Login/LoginContent';

export default function Login() {
  const router = useRouter();
  const { reason } = router.query as {
    reason: LoginRedirectReason;
  };
  const { code, setLoginRedirectReason } = useReferralsContext();
  const { data: referrer } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: code as string },
    { enabled: !!code }
  );
  const observedReason = useRef<string | null>(null);
  const { trackAction } = useTrackEvent();
  const [providers, setProviders] = useState<NextAuthProviders | null>(null);
  useEffect(() => {
    if (!providers) getProviders().then((providers) => setProviders(providers));
  }, []);

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
      <div className="container max-w-xs">
        <TwCard className="mt-6 border p-3 shadow">
          <LoginContent message={redirectReason} />
        </TwCard>
      </div>
    </>
  );
}

type NextAuthProviders = AsyncReturnType<typeof getProviders>;

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

    return {
      props: { providers: null },
    };
  },
});
