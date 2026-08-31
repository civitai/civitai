import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { hubLoginUrl } from '@civitai/auth';
import { resolveSelfOrigin, safePath } from '~/server/auth/oauth-bridge';
import { setLinkSyncCookie } from '~/server/auth/link-sync';

// GET /api/auth/connect?provider=<id>&returnUrl=<same-origin path> — start the hub account-LINK flow from the
// MAIN SERVER. Builds the hub link URL with the server's AUTH_JWT_ISSUER (no client-side hub env var) and 302s
// there; the hub gates on the active session, runs the provider OAuth, attaches <provider> to the CURRENT user,
// and returns to `returnUrl` (with ?error=AccountNotLinked when that identity already belongs to another
// account). Mirrors how /login initiates login server-side — the browser only ever navigates same-origin here.
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) {
    res.status(500).json({ error: 'hub not configured' });
    return;
  }
  const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
  if (!provider) {
    res.status(400).json({ error: 'missing provider' });
    return;
  }
  const selfOrigin = resolveSelfOrigin(req);
  if (!selfOrigin) {
    res.status(500).json({ error: 'self origin not resolvable' });
    return;
  }

  // Absolute, same-origin return target (the hub redirects back here cross-origin after linking). safePath
  // keeps it a same-origin path — no open redirect through the query param. The hub returns to /api/auth/linked
  // so the main app can run post-link side effects it alone can do, which then forwards to the caller's path.
  const linked = new URL('/api/auth/linked', selfOrigin);
  linked.searchParams.set('provider', provider);
  linked.searchParams.set('returnUrl', safePath(req.query.returnUrl));
  const returnUrl = linked.toString();
  // `roles=true` opts into the provider's incremental scope (Discord Linked Roles) — only the /discord/link-role
  // flow passes it; a plain "Connect <provider>" never does, so normal linking can't trip the Linked-Roles scope.
  const linkRoles = req.query.roles === 'true';
  setLinkSyncCookie(req, res, crypto.randomUUID());
  res.redirect(302, hubLoginUrl(HUB, { provider, link: true, linkRoles, returnUrl }));
}
