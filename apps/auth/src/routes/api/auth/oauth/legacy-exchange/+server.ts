import { randomUUID } from 'crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { mintUserSession } from '$lib/server/auth/session';
import { getDeviceId, touchAccount } from '$lib/server/auth/device';
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
export const POST: RequestHandler = async ({ request, cookies }) => {
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
  const userId = Number(claims?.sub ?? claims?.user?.id);
  if (!claims || !Number.isFinite(userId)) return json({ error: 'unauthorized' }, { status: 401 });

  const user = await getOrProduceSessionUser(userId);
  if (!user) return json({ error: 'not_found' }, { status: 404 });

  // Upgrade-on-read is SILENT and repeats on every request from a client that ignores Set-Cookie, so it is the
  // one mint path a ban must stop: otherwise a banned automated client keeps minting and tracking a token per
  // request, growing the very hash the ban has to walk. Deliberately NOT applied to interactive login — a
  // banned user still needs a session to be shown why they were banned and to appeal.
  if (user.bannedAt || user.deletedAt) return json({ error: 'account_disabled' }, { status: 403 });

  const token = await mintUserSession(user);

  // Establish this browser in the device set so the upgraded session gets an account-switcher entry, exactly
  // like an interactive hub login (establishSession) — without this, upgrade-on-read produced a civ-token but
  // NO civ-device. Upgrade-on-read is server-to-server, so the spoke FORWARDS any existing civ-device (reuse it
  // → don't orphan a device set the browser already has) and we MINT one only when absent. We register the
  // account and hand the id back for the spoke to set as its civ-device. Best-effort: a redis-less touch just
  // means no switcher entry, never a failed upgrade.
  const deviceId = getDeviceId(cookies) ?? randomUUID();
  await touchAccount(deviceId, userId);
  return json({ token, deviceId });
};
