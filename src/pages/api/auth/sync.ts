import type { NextApiRequest, NextApiResponse } from 'next';
import { createExchangeClient } from '@civitai/auth';
import { setSessionCookie } from '~/server/auth/civ-cookie';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getBaseUrl } from '~/server/utils/url-helpers';

// Cross-domain login bootstrap — the SPOKE side (section E). A different registrable domain (civitai.red /
// localhost) can't read the hub's `.civitai.com` cookie, so we round-trip through the hub via top-level
// navigation:
//   - no `swap`  → redirect to the hub's /api/auth/sync with this endpoint as the callback (the hub's Lax
//                  .civitai.com cookie rides along on the navigation, so it knows who's signed in).
//   - `swap`     → exchange it at the hub for a civ-token (the swap token is the credential) and set it as
//                  THIS domain's own cookie, then continue to returnUrl.
// This replaces the old AES-civ-token mint (spokes are verify-only and can't mint).
const exchange = createExchangeClient();
const HUB = process.env.AUTH_JWT_ISSUER;

// This spoke's own origin for the callback. Multi-host deploys serve several hosts off one build
// (e.g. test-auth.civitai.com / .red are aliases of one deploy), so a single static NEXT_PUBLIC_BASE_URL
// emits the WRONG callback domain on every alias → the hub rejects it. Resolve it from the request's
// COLOR PRIMARY instead (same rule the rest of the app's outbound URLs follow — see
// docs/multi-host-domain-aliases.md). Still never the raw Host header: getRequestDomainColor only maps a
// CONFIGURED primary/alias → a configured primary; an unrecognized host falls back to NEXT_PUBLIC_BASE_URL.
function resolveSelfOrigin(req: NextApiRequest): string | undefined {
  const fwd = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  const host = fwd?.split(',')[0]?.trim().toLowerCase();
  const color = getRequestDomainColor({ headers: { host } });
  return color ? getBaseUrl(color) : process.env.NEXT_PUBLIC_BASE_URL;
}

// Only ever continue to a same-origin PATH (no open redirect through returnUrl).
function safePath(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) return res.status(400).json({ error: 'hub not configured' });
  const selfOrigin = resolveSelfOrigin(req);
  // Need a resolvable own-origin to build the callback (a configured color primary, or the
  // NEXT_PUBLIC_BASE_URL fallback — never the raw Host header).
  if (!selfOrigin) return res.status(500).json({ error: 'self origin not resolvable' });
  const returnUrl = safePath(req.query.returnUrl);
  const swap = typeof req.query.swap === 'string' ? req.query.swap : undefined;

  // Receive: redeem the swap token → set this domain's civ-token → continue. Suppress Referer so the swap (in
  // the inbound URL) doesn't leak onward.
  if (swap) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const result = await exchange.exchange(swap);
    if (!result) return res.redirect(302, '/login?error=sync');
    setSessionCookie(res, result.token, { host: req.headers.host });
    return res.redirect(302, returnUrl);
  }

  // Initiate: bounce to the hub with this endpoint as the callback + the final returnUrl.
  const hubSync = new URL(`${HUB.replace(/\/+$/, '')}/api/auth/sync`);
  hubSync.searchParams.set('callback', `${selfOrigin.replace(/\/+$/, '')}/api/auth/sync`);
  hubSync.searchParams.set('returnUrl', returnUrl);
  return res.redirect(302, hubSync.toString());
}
