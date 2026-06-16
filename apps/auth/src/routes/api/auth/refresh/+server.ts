import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifier } from '$lib/server/auth/verifier';
import { getSigner, SESSION_COOKIE } from '$lib/server/auth/session';
import { sessions } from '$lib/server/auth/registry';
import { getDeviceId, touchAccount } from '$lib/server/auth/device';
import { bearerToken } from '$lib/server/auth/request';

// POST /api/auth/refresh — ROLLING SESSION. Given a still-valid civ-token (Bearer or cookie), verify it
// (signature + expiry + REVOCATION — verifier.verifyToken enforces all three, so a logged-out / banned /
// globally-invalidated token is rejected), then mint a FRESH token for the SAME user + SAME `jti` with a new
// signedAt/exp — extending the window WITHOUT changing session identity (revocation + tracking keep applying).
// The main app calls this server-side once a token crosses AUTH_SESSION_UPDATE_AGE, then re-sets the cookie.
// See docs/main-app-auth-cutover.md (section C). An expired token fails verification → 401 → re-login.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const token = bearerToken(request) || cookies.get(SESSION_COOKIE);
  if (!token) return json({ error: 'unauthorized' }, { status: 401 });

  const claims = await verifier.verifyToken(token).catch(() => null);
  const userId = Number(claims?.sub);
  const jti = claims?.jti;
  if (!claims || !Number.isFinite(userId) || !jti)
    return json({ error: 'unauthorized' }, { status: 401 });

  const fresh = await getSigner().mintSessionToken(
    {
      sub: String(userId),
      signedAt: Date.now(),
      // Preserve moderator impersonation (F) across the roll — otherwise an impersonation session older than
      // the update age silently becomes a real session for the target (and the exit path / audit break).
      ...(claims.impersonatedBy ? { impersonatedBy: claims.impersonatedBy } : {}),
    },
    { jti } // same jti → same session, fresh window
  );
  // Refresh the token-tracking TTL so an actively-used session's tracking entry doesn't lapse.
  await sessions.trackToken(jti, userId).catch(() => {});

  // Keep the ACTIVE account fresh in this browser's switcher: a rolling refresh (section C) means the user is
  // active, so slide the account's 30-day idle clock + roll the device record TTL. Without this, an actively-
  // used-but-never-switched account would age out of its own switcher after 30 days. (Device cookie forwarded
  // by the main app's maybeRollHubCookie.)
  const deviceId = getDeviceId(cookies);
  if (deviceId) await touchAccount(deviceId, userId).catch(() => {});

  return json({ token: fresh });
};
