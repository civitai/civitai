import * as z from 'zod';
import { createImpersonationClient } from '@civitai/auth';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { setSessionCookie } from '~/server/auth/civ-cookie';

// Moderator impersonation proxy (section F) — a DUMB pass-through to the hub, which owns ALL the logic: the
// granted-permission gate, the mint (stamped impersonatedBy), and the ModActivity audit. This proxy exists only
// because the main app also deploys cross-site as civitai.red, where the browser can't reach the hub directly;
// it forwards the moderator's session cookie and sets the civ-token the hub returns. Touches no device set.
//   POST   { userId }  → start impersonating that user
//   DELETE             → stop impersonating (the hub reads `impersonatedBy` from the current token)
const impersonation = createImpersonationClient();
const schema = z.object({ userId: z.coerce.number() });

export default AuthedEndpoint(
  async function handler(req, res) {
    const cookie = req.headers.cookie ?? '';

    if (req.method === 'DELETE') {
      const result = await impersonation.exit(cookie);
      // Forward the hub's REAL status + reason (e.g. 400 "not an impersonation session", 404, 500) instead of
      // masking every failure as a generic message. status 0 = hub unreachable → 502.
      if (!result.ok) {
        return res
          .status(result.status || 502)
          .json({ error: result.error ?? 'could not exit impersonation' });
      }
      setSessionCookie(res, result.token, { host: req.headers.host });
      return res.status(200).json({ ok: true });
    }

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const minted = await impersonation.impersonate(cookie, parsed.data.userId);
    if (!minted.ok) {
      return res
        .status(minted.status || 502)
        .json({ error: minted.error ?? 'Could not impersonate' });
    }

    // NB: impersonation deliberately does NOT touch the device account-set
    setSessionCookie(res, minted.token, { host: req.headers.host });
    return res.status(200).json({ ok: true });
  },
  ['POST', 'DELETE']
);
