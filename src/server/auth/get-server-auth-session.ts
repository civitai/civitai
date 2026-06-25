import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
// FINAL-CLEANUP: `Session` is the app-wide session return type; replace it with a first-party type when the
// `next-auth` dependency is dropped. This is the only remaining next-auth reference here, and it's type-only.
import type { Session } from '~/types/session';
import {
  sessionCookieName,
  deviceCookieName,
  decodeLegacySessionCookie,
  legacySessionCookieName,
} from '@civitai/auth';
import { env } from '~/env/server';
import { isPreview } from '~/env/other';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import {
  getHubSession,
  maybeRollHubCookie,
  maybeUpgradeLegacySession,
  sessionClient,
} from './session-client';

type AuthRequest = (GetServerSidePropsContext['req'] | NextApiRequest) & {
  context?: Record<string, unknown>;
};
type AuthResponse = GetServerSidePropsContext['res'] | NextApiResponse;

// Legacy next-auth session cookie (`civitai-token` / prod `__Secure-civitai-token`) — READ-ONLY during the
// cutover, decoded via jose (no next-auth). The cookie name is resolved with the SAME dev/prod secure logic as
// the hub cookie (`legacySessionCookieName()`), so prod reads the `__Secure-` variant. Resolves the embedded
// userId to a FRESH session user (cache/DB); sunsets as these cookies age out. New sessions are the hub's ES256.
async function getLegacySession(req: AuthRequest): Promise<Session | null> {
  const secret = env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const token = req.cookies?.[legacySessionCookieName()];
  if (!token) return null;
  const claims = await decodeLegacySessionCookie(token, secret);
  const userId = Number(claims?.sub ?? claims?.user?.id);
  if (!Number.isFinite(userId)) return null;
  const user = await sessionClient.getSessionUserById(userId);
  if (user) return { user } as Session;
  // PREVIEW-ONLY fallback. getSessionUserById resolves a user from the shared
  // session cache then the centralized hub (auth.civitai.com) — both of which read
  // the PRODUCTION identity store. A PR preview runs against the dev DB clone, where
  // the ci-smoke-* smoke users are seeded (datapacket-talos seed-smoke-test-users
  // CronJob) but the hub has no row for them, so the lookup returns null and every
  // authenticated smoke request would loop back to /login. On a preview deploy we
  // therefore trust the rich `user` embedded in the minted legacy cookie — exactly
  // what the pre-cutover gate did (it read token.user straight from the cookie, no
  // DB hit). Gated on IS_PREVIEW: production NEVER trusts the embedded user (it must
  // resolve via the hub), so this has zero production blast radius.
  if (isPreview && claims?.user && claims.user.id != null) {
    return { user: claims.user } as unknown as Session;
  }
  return null;
}

export const getServerAuthSession = async ({
  req,
  res,
}: {
  req: AuthRequest;
  res: AuthResponse;
}): Promise<Session | null> => {
  if (req.context?.session) return req.context.session as Session | null;

  // API/bearer token (Authorization header or `?token=`, excluding the webhook token).
  let token: string | undefined;
  if (req.headers.authorization) token = req.headers.authorization.split(' ')[1];
  else if (req.url) {
    const url = new URL(req.url, getBaseUrl());
    if (url.searchParams.get('token') !== env.WEBHOOK_TOKEN)
      token = url.searchParams.get('token') || undefined;
  }

  if (!req.context) req.context = {};
  if (token) {
    if (!req.context?.session) {
      const result = await getSessionFromBearerToken(token);
      req.context.session = result;
      if (result && 'tokenScope' in result) {
        req.context.tokenScope = result.tokenScope;
        req.context.buzzLimit = (result as any).buzzLimit ?? null;
        req.context.apiKeyId = (result as any).apiKeyId ?? null;
        req.context.subject = (result as any).subject ?? null;
      }
    }
    return req.context.session as Session | null;
  }

  // 1. Hub civ-token: verify locally → shared cache → hub on miss. Rolling-refresh on activity.
  const hub = await getHubSession(req).catch(() => null);
  if (hub) {
    req.context.session = hub;
    const civ = req.cookies?.[sessionCookieName()];
    const device = req.cookies?.[deviceCookieName()];
    if (civ) await maybeRollHubCookie(civ, device, res, req.headers.host);
    return hub;
  }

  // 2. Legacy next-auth cookie (jose decode → fresh user). Sunsets as the old cookies age out.
  const legacy = await getLegacySession(req).catch(() => null);
  req.context.session = legacy;
  // Upgrade-on-read: migrate this legacy user to a civ-token (+ de-crud the next-auth cookies) for next time.
  // Best-effort; this request is still served from the legacy decode above.
  if (legacy) {
    const legacyToken = req.cookies?.[legacySessionCookieName()];
    const device = req.cookies?.[deviceCookieName()];
    await maybeUpgradeLegacySession(legacyToken, device, res, req.headers.host).catch(() => {});
  }
  return legacy;
};
