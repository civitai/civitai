import { json, error } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getSigner } from '$lib/server/auth/session';
import { isInternalRequest } from '$lib/server/auth/internal';

// DEV-ONLY auth bypass: mint a session token for a given userId so integration tests (the identity smoke
// script) can "sign in" without the OAuth/email flow. DOUBLE-GATED — 404 unless BOTH (a) running under
// `vite dev` AND (b) a valid AUTH_INTERNAL_TOKEN is presented. It is not built into / reachable in prod.
export const POST: RequestHandler = async ({ request }) => {
  if (!dev || !isInternalRequest(request)) error(404, 'Not found');

  let body: { userId?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const userId = Number(body.userId);
  if (!Number.isFinite(userId)) return json({ error: 'bad_request' }, { status: 400 });

  // Mint a thin session token { sub, id (jti), signedAt } signed with the hub key — verifiable by the
  // same hub verifier that GET /api/auth/identity uses.
  const tokenId = randomUUID();
  const token = await getSigner().mintSessionToken(
    { sub: String(userId), signedAt: Date.now() },
    { jti: tokenId }
  );
  return json({ token, userId });
};
