import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { mintUserSession } from '$lib/server/auth/session';
import { isInternalRequest } from '$lib/server/auth/internal';

// POST /api/auth/oauth/legacy-exchange — migration-window UPGRADE-ON-READ. A trusted spoke server (the main app)
// hands us a still-valid LEGACY next-auth cookie; we re-decode it (the verifier holds NEXTAUTH_SECRET), resolve
// the user, and mint a fresh civ-token for the SAME user. The spoke then sets that token as its civ-token cookie
// (clearing the legacy cookies in the same response), so legacy users migrate to the thin-session model — and
// get de-crudded of next-auth cookies — just by browsing, without waiting for a re-login/logout.
//
// Two factors: AUTH_INTERNAL_TOKEN proves the caller is a trusted server, and the legacy cookie ITSELF proves
// WHO. We NEVER trust a caller-supplied userId — re-decoding the cookie keeps it the trust anchor, so this is
// NOT a "mint any session" primitive (a leaked AUTH_INTERNAL_TOKEN can't forge a session without a valid legacy
// cookie). verifyToken also enforces the swap-purpose guard + revocation. Delete this route alongside the
// legacy decode (legacy-cookie.ts) once the old cookies have aged out.
export const POST: RequestHandler = async ({ request }) => {
  if (!isInternalRequest(request)) return json({ error: 'unauthorized' }, { status: 401 });

  let body: { legacyToken?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const legacyToken = typeof body.legacyToken === 'string' ? body.legacyToken : '';
  if (!legacyToken) return json({ error: 'bad_request' }, { status: 400 });

  // Re-decode to PROVE identity (mirrors the main app's getLegacySession: `sub`, falling back to `user.id`).
  const claims = await verifier.verifyToken(legacyToken).catch(() => null);
  const userId = Number(claims?.sub ?? (claims as { user?: { id?: number } } | null)?.user?.id);
  if (!claims || !Number.isFinite(userId)) return json({ error: 'unauthorized' }, { status: 401 });

  const user = await getOrProduceSessionUser(userId);
  if (!user) return json({ error: 'not_found' }, { status: 404 });

  const token = await mintUserSession(user);
  return json({ token });
};
