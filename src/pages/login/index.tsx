import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { TwCard } from '~/components/TwCard/TwCard';
import { LoginContent } from '~/components/Login/LoginContent';
import { isDev } from '~/env/other';

export default function Login() {
  return (
    <>
      <Meta title="Sign in to Civitai" canonical="/login" />
      <div className="container max-w-xs">
        <TwCard className="mt-6 border p-3 shadow">
          <LoginContent />
        </TwCard>
      </div>
    </>
  );
}

function isSafeCrossOriginRedirect(url: string): boolean {
  try {
    return isDev || new URL(url).origin.includes('civitai');
  } catch {
    return false;
  }
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const { callbackUrl, returnUrl, error, reason } = ctx.query;
    // Only bounce genuinely-authenticated users away from the login page. The
    // session callback returns a truthy-but-userless object ({} / { needsCookieRefresh })
    // for invalidated/expired tokens (next-auth-options.ts session()), so a plain
    // `if (session)` would redirect a logged-out user to their returnUrl — and any
    // page gating on `!session?.user` redirects right back here → infinite login loop.
    if (session?.user) {
      if (reason !== 'switch-accounts') {
        const rawCallback =
          typeof returnUrl === 'string'
            ? returnUrl
            : typeof callbackUrl === 'string'
            ? callbackUrl
            : '/';
        // Prevent recursive login redirects
        const safeCallback = rawCallback.startsWith('/login') ? '/' : rawCallback;

        // Allow cross-domain redirects to known civitai domains
        if (isSafeCrossOriginRedirect(safeCallback)) {
          return {
            redirect: {
              destination: safeCallback,
              permanent: false,
            },
          };
        }

        const destinationURL = new URL(safeCallback, getBaseUrl());
        if (error) destinationURL.searchParams.set('error', error as string);
        const destination = `${destinationURL.pathname}${destinationURL.search}${destinationURL.hash}`;

        return {
          redirect: {
            destination,
            permanent: false,
          },
        };
      }

      return { props: { providers: null } };
    }

    // Not signed in: once the hub is the issuer (AUTH_JWT_ISSUER set), send login there. No-op
    // until that env var is configured. Skipped when there's an error to surface on this page or
    // an explicit account-switch. NOTE: AUTH_JWT_ISSUER also gates RS256 verification, so setting
    // it moves login to the hub at the same time.
    const hubIssuer = process.env.AUTH_JWT_ISSUER;
    if (hubIssuer && !error && reason !== 'switch-accounts') {
      const rawReturn =
        typeof returnUrl === 'string'
          ? returnUrl
          : typeof callbackUrl === 'string'
          ? callbackUrl
          : '/';
      // Guard against a /login → hub → /login loop.
      const safeReturn = rawReturn.startsWith('/login') ? '/' : rawReturn;
      // The hub returns the user to the main app's post-login handler — which runs the login side-effects
      // the hub can't (ref_* cookies + tracking/referral/notification services) and then forwards to the
      // real destination. See src/pages/api/auth/post-login.ts.
      const postLogin = new URL('/api/auth/post-login', getBaseUrl());
      postLogin.searchParams.set('dest', safeReturn);
      const hubLogin = new URL('/login', hubIssuer);
      hubLogin.searchParams.set('returnUrl', postLogin.toString());
      return {
        redirect: {
          destination: hubLogin.toString(),
          permanent: false,
        },
      };
    }

    return {
      props: { providers: null },
    };
  },
});
