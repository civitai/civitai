import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { runLoginSideEffects } from '~/server/auth/login-side-effects';
import { getBaseUrl } from '~/server/utils/url-helpers';

// Post-login landing for the hub flow. The main app sends users to the hub with
// returnUrl = <origin>/api/auth/post-login?dest=<original>. After the hub mints the civ-token and redirects
// back here, we run the login side-effects ON THE MAIN APP — the hub can't: the `ref_*` cookies are on the
// civitai.com domain and the Tracker / notification / referral services are main-app-only — then forward to
// `dest`. New-vs-returning is derived from the resolved user's `createdAt`. See docs/main-app-auth-cutover.md (B).
//
// Idempotency: this URL is only hit as the hub's redirect target (once per login), so side-effects fire once
// in the normal flow; the new-user ops (referral, join-community notification with its dedup key) are
// independently idempotent. A manual refresh of this endpoint is the only re-fire path.
const NEW_USER_WINDOW_MS = 5 * 60 * 1000;

function safeDest(dest: unknown): string {
  if (typeof dest !== 'string' || !dest) return '/';
  if (dest.startsWith('/') && !dest.startsWith('//') && !dest.startsWith('/\\')) return dest;
  try {
    const u = new URL(dest);
    if (u.origin === new URL(getBaseUrl()).origin) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* fall through */
  }
  return '/';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const dest = safeDest(req.query.dest);

  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) {
    // The hub login didn't land a session (cookie not set / verification failed) — bounce back to /login.
    res.redirect(302, '/login');
    return;
  }

  const createdAt = (user as { createdAt?: Date | string }).createdAt;
  const isNewUser = createdAt
    ? Date.now() - new Date(createdAt).getTime() < NEW_USER_WINDOW_MS
    : false;

  // The login `reason` rides in this URL (re-homed off the legacy LoginContent cookie) so referral attribution
  // still sees it without an in-page login surface.
  const loginRedirectReason = typeof req.query.reason === 'string' ? req.query.reason : undefined;

  // Best-effort — a failure here must never strand the user on a blank page; they still reach `dest`.
  await runLoginSideEffects({ req, res, userId: user.id, isNewUser, loginRedirectReason }).catch(
    () => null
  );

  res.redirect(302, dest);
}
