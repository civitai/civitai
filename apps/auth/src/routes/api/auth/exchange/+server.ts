import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import { mintUserSession } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { consumeSwapToken } from '$lib/server/auth/swap';

// POST /api/auth/exchange — redeem a cross-domain SWAP token for a civ-token. A spoke on a DIFFERENT registrable
// domain (civitai.red / localhost) can't read the hub's .civitai.com cookie, so it gets a short-lived swap token
// via a top-level redirect (GET /api/auth/sync) and exchanges it here, server-to-server, for a session token it
// sets as its OWN cookie. The swap token is the only credential — no session cookie needed. Single-use: the jti
// is burned so a token captured from the redirect URL can't be replayed. See cutover doc (E, cross-domain).
export const POST: RequestHandler = async ({ request }) => {
  let body: { swapToken?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const swapToken = typeof body.swapToken === 'string' ? body.swapToken : '';
  if (!swapToken) error(400, 'missing swap token');

  const verified = await verifier.verifySwapToken(swapToken);
  if (!verified) error(401, 'invalid swap token');
  if (!(await consumeSwapToken(verified.jti))) error(409, 'swap token already used');

  const user = await getOrProduceSessionUser(verified.userId);
  if (!user) error(404, 'no such user');

  const token = await mintUserSession(user);
  return json({ token, userId: user.id });
};
