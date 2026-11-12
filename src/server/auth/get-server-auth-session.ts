import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
// FINAL-CLEANUP: `Session` is the app-wide session return type; replace it with a first-party type when the
// `next-auth` dependency is dropped. This is the only remaining next-auth reference here, and it's type-only.
import type { Session } from '~/types/session';
import { legacySessionCookieName, readDeviceId, readSessionToken, rollSlot } from '@civitai/auth';
import { env } from '~/env/server';
import { matchWebhookToken } from '~/server/utils/webhook-token';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import { refuseModerationAccountSession } from './moderation-account';
import { decodePreviewSessionCookie, previewCookieSignInEnabled } from './preview-session-cookie';
import { getHubSession, maybeRollHubCookie } from './session-client';

type AuthRequest = (GetServerSidePropsContext['req'] | NextApiRequest) & {
  context?: Record<string, unknown>;
};
type AuthResponse = GetServerSidePropsContext['res'] | NextApiResponse;

// PR previews only: the pipeline's smoke users carry a `civitai-token` cookie (preview-session-cookie.ts). The
// session is the user embedded in that cookie. A preview runs on a dev DB clone whose smoke users the hub has no
// rows for, so the hub is never asked.
async function getPreviewCookieSession(req: AuthRequest): Promise<Session | null> {
  const secret = env.NEXTAUTH_SECRET;
  if (!secret || !previewCookieSignInEnabled()) return null;
  const token = req.cookies?.[legacySessionCookieName()];
  if (!token) return null;
  const user = (await decodePreviewSessionCookie(token, secret))?.user;
  const id = Number(user?.id);
  if (!user || !Number.isFinite(id)) return null;
  const username = (user as { username?: string | null }).username;
  if (refuseModerationAccountSession({ id, username }, 'legacy-cookie')) return null;
  return { user } as unknown as Session;
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
    if (!matchWebhookToken(url.searchParams.get('token')))
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
        req.context.apiKeyType = (result as any).apiKeyType ?? null;
        req.context.subject = (result as any).subject ?? null;
      }
    }
    return req.context.session as Session | null;
  }

  // 1. Hub civ-token: verify locally → shared cache → hub on miss. Rolling-refresh on activity.
  const hub = await getHubSession(req).catch(() => null);
  if (hub) {
    req.context.session = hub;
    const civ = readSessionToken(req.cookies);
    const slot = civ && rollSlot(civ);
    const device = readDeviceId(req.cookies)?.value;
    if (civ && slot) {
      await maybeRollHubCookie(civ.value, device, res, req.headers.host, slot, req.cookies);
    }
    return hub;
  }

  // 2. PR previews only: the pipeline's test sign-in cookie.
  const preview = await getPreviewCookieSession(req).catch(() => null);
  req.context.session = preview;
  return preview;
};
