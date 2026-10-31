import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import { familyId } from '@civitai/auth';
import { refuseModerationAccount, reissueSession, SESSION_COOKIE } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { markFamilyLive } from '$lib/server/auth/lineage';
import { getDeviceId, touchAccount } from '$lib/server/auth/device';
import { bearerToken } from '$lib/server/auth/request';
import { readInternalCaller } from '$lib/server/auth/s2s';

// POST /api/auth/refresh — ROLLING SESSION. Given a still-valid civ-token (in the body of an `internal`-shape
// call, or as the Bearer or cookie), verify it
// (signature + expiry + REVOCATION — verifier.verifyToken enforces all three, so a logged-out / banned /
// globally-invalidated token is rejected), then mint a FRESH token for the SAME user + SAME `jti` with a new
// signedAt/exp — extending the window WITHOUT changing session identity (revocation + tracking keep applying).
// The main app calls this server-side once a token crosses AUTH_SESSION_UPDATE_AGE, then re-sets the cookie.
// See docs/main-app-auth-cutover.md (section C). An expired token fails verification → 401 → re-login.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const internal = await readInternalCaller(request);
  const token = internal ? internal.token : bearerToken(request) || cookies.get(SESSION_COOKIE);
  if (!token) error(401, 'unauthorized');

  const claims = await verifier.verifyToken(token).catch(() => null);
  const userId = Number(claims?.sub);
  const jti = claims?.jti;
  if (!claims || !Number.isFinite(userId) || !jti) error(401, 'unauthorized');
  refuseModerationAccount({ id: userId }, 'refresh');
  // Checked against the current account, not the token: a session that rolls must not outlive a ban.
  if (!(await isActiveAccount(userId))) error(403, 'account_disabled');
  if (claims.impersonatedBy != null && !(await isActiveAccount(claims.impersonatedBy)))
    error(403, 'account_disabled');

  // Same jti, family, sign-in time and impersonation: the same session with a fresh window.
  const fresh = await reissueSession(claims, userId, jti);
  await markFamilyLive(familyId(claims));

  // Keep the ACTIVE account fresh in this browser's switcher: a rolling refresh (section C) means the user is
  // active, so slide the account's 30-day idle clock + roll the device record TTL. Without this, an actively-
  // used-but-never-switched account would age out of its own switcher after 30 days. (Device cookie forwarded
  // by the main app's maybeRollHubCookie.)
  const deviceId = internal ? internal.deviceId : getDeviceId(cookies);
  if (deviceId) await touchAccount(deviceId, userId).catch(() => {});

  return json({ token: fresh });
};

async function isActiveAccount(userId: number): Promise<boolean> {
  const user = await getOrProduceSessionUser(userId);
  return !!user && !user.bannedAt && !user.deletedAt;
}
