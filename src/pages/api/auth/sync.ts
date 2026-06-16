import type { NextApiRequest, NextApiResponse } from 'next';
import { createExchangeClient } from '@civitai/auth';
import { setSessionCookie } from '~/server/auth/civ-cookie';

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
// This spoke's own origin (per-deployment: civitai.com / civitai.red / http://localhost:3000).
const SELF_ORIGIN = process.env.NEXT_PUBLIC_BASE_URL;

// Only ever continue to a same-origin PATH (no open redirect through returnUrl).
function safePath(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) return res.status(400).json({ error: 'hub not configured' });
  const returnUrl = safePath(req.query.returnUrl);
  const swap = typeof req.query.swap === 'string' ? req.query.swap : undefined;

  // Receive: redeem the swap token → set this domain's civ-token → continue.
  if (swap) {
    const result = await exchange.exchange(swap);
    if (!result) return res.redirect(302, '/login?error=sync');
    setSessionCookie(res, result.token);
    return res.redirect(302, returnUrl);
  }

  // Initiate: bounce to the hub with this endpoint as the callback + the final returnUrl.
  const origin = SELF_ORIGIN ?? `https://${req.headers.host}`;
  const hubSync = new URL(`${HUB.replace(/\/+$/, '')}/api/auth/sync`);
  hubSync.searchParams.set('callback', `${origin.replace(/\/+$/, '')}/api/auth/sync`);
  hubSync.searchParams.set('returnUrl', returnUrl);
  return res.redirect(302, hubSync.toString());
}
