import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import type { ParsedUrlQuery } from 'node:querystring';
// FINAL-CLEANUP: `Session` is the app-wide session return type; replace it with a first-party type when the
// `next-auth` dependency is dropped. This is the only remaining next-auth reference here, and it's type-only.
import type { Session } from '~/types/session';
import {
  legacySessionCookieName,
  readDeviceId,
  readSessionToken,
  rollSlot,
  sessionCookieMode,
} from '@civitai/auth';
import { env } from '~/env/server';
import { matchWebhookToken } from '~/server/utils/webhook-token';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { getSessionFromBearerToken } from './bearer-token';
import { applySessionScope, type SessionScope } from './session-scope';
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

type ServerAuthSessionArgs = {
  req: AuthRequest;
  res: AuthResponse;
  scope?: SessionScope;
  /** A page's route params (`GetServerSidePropsContext.query`), for the scope decision log. */
  query?: ParsedUrlQuery;
};

/**
 * The request's session, with a bearer credential held to `scope` (see `SessionScope`). The
 * credential and the unscoped session are recorded on `req.context`, so every call re-applies its
 * own `scope`.
 */
export const getServerAuthSession = async ({
  req,
  res,
  scope,
  query,
}: ServerAuthSessionArgs): Promise<Session | null> =>
  applySessionScope(req, await resolveSession(req, res), scope, query).session;

async function resolveSession(req: AuthRequest, res: AuthResponse): Promise<Session | null> {
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
      // The session can reach page props, so it carries the scope as a number. Scope checks must read
      // the bigint `req.context.tokenScope`: a bitwise op on the number is 32-bit and drops bits 31-32.
      req.context.session = result && { ...result, tokenScope: Number(result.tokenScope) };
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
    const host = req.headers.host;
    const civ = readSessionToken(req.cookies, { host });
    const slot = civ && rollSlot(civ, sessionCookieMode(host));
    const device = readDeviceId(req.cookies, { host })?.value;
    if (civ && slot) {
      await maybeRollHubCookie(civ.value, device, res, req.headers.host, slot, req.cookies);
    }
    return hub;
  }

  // 2. PR previews only: the pipeline's test sign-in cookie.
  const preview = await getPreviewCookieSession(req).catch(() => null);
  req.context.session = preview;
  return preview;
}
