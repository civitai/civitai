import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { runLoginSideEffects } from '~/server/auth/login-side-effects';
import {
  clearAllSessionCookies,
  POST_LOGIN_RETRY_COOKIE,
  postLoginRetryCookie,
  clearPostLoginRetryCookie,
} from '~/server/auth/civ-cookie';
import { renderSignInProblemHtml } from '~/server/auth/login-error-page';
import { logToAxiom } from '~/server/logging/client';
import { getBaseUrl } from '~/server/utils/url-helpers';

// Fire-and-forget structured log — see the note in authorize.ts. `['civitai-prod'] | where name == 'auth-flow'`;
// the `no-session-*` outcomes here are the civ-token-lands-but-won't-verify loop that authorize.ts can't see.
const logAuth = (req: NextApiRequest, outcome: string, extra?: Record<string, unknown>) =>
  logToAxiom(
    { name: 'auth-flow', step: 'post-login', outcome, host: req.headers.host, ...extra },
    'civitai-prod'
  ).catch(() => undefined);

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
    // The hub login didn't land a USABLE session. The civ-token cookie either never arrived OR arrived but can't
    // be verified (bad issuer / clock skew / key rotation) — the latter is invisible to /api/auth/authorize's
    // presence-only marker, so post-login ⇄ /login loops forever (ERR_TOO_MANY_REDIRECTS, ClickUp 868k9gug8).
    // Break it with a one-shot retry budget: bounce once so a transient miss self-heals, then stop on the second
    // consecutive miss, wiping the wedged cookies so the next attempt starts clean.
    const retries = Number.parseInt(req.cookies[POST_LOGIN_RETRY_COOKIE] ?? '', 10) || 0;
    if (retries >= 1) {
      logAuth(req, 'no-session-terminal', { retries });
      res.setHeader('Set-Cookie', clearAllSessionCookies(req.headers.host));
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderSignInProblemHtml());
      return;
    }
    logAuth(req, 'no-session-retry', { retries });
    res.setHeader('Set-Cookie', postLoginRetryCookie(retries + 1));
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

  // Session resolved — retire any retry budget from an earlier wedged attempt (append, don't clobber side-effect
  // cookies). Only when the cookie is actually present, so a clean login stays a single Set-Cookie-free redirect.
  if (req.cookies[POST_LOGIN_RETRY_COOKIE]) {
    const existing = res.getHeader('Set-Cookie');
    const all = Array.isArray(existing)
      ? existing.map(String)
      : existing != null
      ? [String(existing)]
      : [];
    all.push(clearPostLoginRetryCookie());
    res.setHeader('Set-Cookie', all);
  }

  // A callback:success with no matching post-login:success (a no-session-* instead) is the cookie-didn't-land
  // signature — logging both legs lets that gap be measured per color.
  logAuth(req, 'success', { isNewUser });
  res.redirect(302, dest);
}
