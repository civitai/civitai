import { error } from '@sveltejs/kit';

// Small shared request helpers so the auth route handlers (switch / impersonate / refresh) follow one shape.

/** Parse `{ userId }` from a JSON body; throws a 400 if it's missing or non-numeric. */
export async function readUserId(request: Request): Promise<number> {
  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) error(400, 'bad userId');
  return userId;
}

/** The Bearer token from the Authorization header, or '' if absent. */
export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return /^bearer /i.test(header) ? header.slice(7).trim() : '';
}

/**
 * The TRUE client IP, resolved from proxy headers — NOT the socket peer. Behind the k8s ingress
 * (and Cloudflare) adapter-node's getClientAddress() returns the shared ingress-pod address, so a
 * per-IP rate limit keyed on it collapses into ONE global bucket for every user. Mirrors the main
 * app's request-ip resolution: prefer Cloudflare's `cf-connecting-ip` (CF overwrites any client-
 * supplied value, so it's trustworthy in our CF → ingress → node stack), then the leftmost
 * `x-forwarded-for` hop (the client as the edge recorded it). Returns null when neither is present
 * so callers SKIP limiting rather than bucket everyone together — per-client or not at all.
 */
export function getClientIp(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || null;
}
