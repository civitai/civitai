// Producer API auth — a WEBHOOK_TOKEN-style shared secret on the internal-only ingress (plan R2). This
// is net-new surface: the external notification-server was GET-only and unauthed. Accepts the token via
// `Authorization: Bearer <token>` (what the @civitai/notifications client sends) or an `x-webhook-token`
// header. When NOTIFICATIONS_TOKEN is unset the gate is DISABLED — dev only; prod always sets it.
//
// Constant-time compare so a timing side-channel can't leak the token byte-by-byte.

import { timingSafeEqual } from 'node:crypto';
import { notificationsToken } from '../../env';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function presentedToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers['authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr) {
    const [scheme, token] = authStr.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }
  const webhook = headers['x-webhook-token'];
  return Array.isArray(webhook) ? webhook[0] : webhook;
}

/** True when the request carries the shared secret (or the gate is disabled because none is set). */
export function isAuthorized(headers: Record<string, string | string[] | undefined>): boolean {
  if (!notificationsToken) return true;
  const token = presentedToken(headers);
  return token !== undefined && safeEqual(token, notificationsToken);
}
