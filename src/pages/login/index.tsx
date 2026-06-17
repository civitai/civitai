import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { buildHubLoginRedirect } from '~/server/auth/login-redirect';
import { isDev } from '~/env/other';

// /login is now just a server-side redirect to the centralized hub (auth.civitai.com) — the hub owns the login
// UI. We keep the route because it's a heavily-used redirect target (getLoginLink + many direct links); it
// forwards to the hub, threading returnUrl (via post-login), reason, error, and the add-account prompt. Nothing
// renders here — getServerSideProps always redirects.
export default function Login() {
  return null;
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
    const rawReturn =
      typeof returnUrl === 'string'
        ? returnUrl
        : typeof callbackUrl === 'string'
        ? callbackUrl
        : '/';
    // Guard against a /login → … → /login loop.
    const safeReturn = rawReturn.startsWith('/login') ? '/' : rawReturn;
    const isSwitch = reason === 'switch-accounts';

    // Genuinely signed in (a truthy-but-userless session = invalidated/expired token, so gate on `user`) AND not
    // adding another account → straight to the destination.
    if (session?.user && !isSwitch) {
      if (isSafeCrossOriginRedirect(safeReturn)) {
        return { redirect: { destination: safeReturn, permanent: false } };
      }
      const destinationURL = new URL(safeReturn, getBaseUrl());
      if (typeof error === 'string' && error) destinationURL.searchParams.set('error', error);
      const destination = `${destinationURL.pathname}${destinationURL.search}${destinationURL.hash}`;
      return { redirect: { destination, permanent: false } };
    }

    // Otherwise send to the hub login. It returns to /api/auth/post-login (which runs the side-effects the hub
    // can't — ref_* cookies + tracking/referral) then to the real dest. `reason` rides both URLs (attribution +
    // hub analytics); `error` shows on the hub page; switch-accounts adds prompt=select_account.
    const hubIssuer = process.env.AUTH_JWT_ISSUER;
    // No hub configured → nowhere to log in; degrade to home rather than render a dead page.
    if (!hubIssuer) return { redirect: { destination: '/', permanent: false } };

    // Land back on the user's OWN origin (the request host), not a fixed primary — so a civitai.red user stays
    // on .red instead of bouncing to green. Cross-site relative to the hub, wrap in /api/auth/sync first so this
    // domain mints its own cookie before post-login runs (mirrors the popup path's hubLoginEntryUrl).
    const host = (ctx.req.headers['x-forwarded-host'] ?? ctx.req.headers.host) as string | undefined;
    const proto =
      (ctx.req.headers['x-forwarded-proto'] as string | undefined) ??
      (host && !host.includes('localhost') ? 'https' : 'http');
    const origin = host ? `${proto}://${host}` : getBaseUrl();
    const destination = buildHubLoginRedirect({
      origin,
      hubIssuer,
      dest: safeReturn,
      reason: typeof reason === 'string' ? reason : undefined,
      error: typeof error === 'string' ? error : undefined,
      selectAccount: isSwitch,
    });

    return { redirect: { destination, permanent: false } };
  },
});
