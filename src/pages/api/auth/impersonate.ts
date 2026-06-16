import * as z from 'zod';
import { createImpersonationClient, sessionCookieName } from '@civitai/auth';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { setSessionCookie } from '~/server/auth/civ-cookie';
import { decodeTokenClaim } from '~/server/auth/token-claims';

// Moderator impersonation proxy (section F). The hub is the sole minter; this same-origin proxy forwards the
// moderator's session cookie to the hub via the @civitai/auth impersonation client (the hub's ONLY gate is that
// the requester is a moderator — no internal token, no extra credential), sets the returned civ-token, and
// writes the ModActivity audit (a main-app concern). Replaces the old AES civ-token switch entirely.
//   POST   { userId }  → start impersonating that user
//   DELETE             → stop impersonating (the hub reads `impersonatedBy` from the current token)
const impersonation = createImpersonationClient();
const schema = z.object({ userId: z.coerce.number() });

export default AuthedEndpoint(async function handler(req, res, user) {
  const cookie = req.headers.cookie ?? '';

  if (req.method === 'DELETE') {
    // Exit impersonation — authority is the `impersonatedBy` claim on the current session (hub-side).
    const result = await impersonation.exit(cookie);
    if (!result) return res.status(400).json({ error: 'not impersonating' });
    setSessionCookie(res, result.token);
    const civToken = req.cookies[sessionCookieName()];
    const modId = civToken ? decodeTokenClaim(civToken, 'impersonatedBy') : undefined;
    if (modId) {
      await trackModActivity(modId, { entityType: 'impersonate', entityId: user.id, activity: 'off' });
    }
    return res.status(200).json({ ok: true });
  }

  // POST — start impersonating. Gate: the requester is a moderator who *can* impersonate (the hub re-checks
  // moderator status; this is the "can impersonate" feature half).
  const features = getFeatureFlags({ user, req });
  if (!features?.impersonation) return res.status(401).json({ error: 'Unauthorized' });

  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: result.error.message });
  const { userId } = result.data;
  if (userId === user.id) return res.status(400).json({ error: 'Cannot impersonate self' });

  const minted = await impersonation.impersonate(cookie, userId);
  if (!minted) return res.status(403).json({ error: 'Could not impersonate' });

  setSessionCookie(res, minted.token); // NB: impersonation deliberately does NOT touch the device account-set
  await trackModActivity(user.id, { entityType: 'impersonate', entityId: userId, activity: 'on' });
  return res.status(200).json({ ok: true });
}, ['POST', 'DELETE']);
