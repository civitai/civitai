import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyDevTunnelAccessToken } from '~/server/services/blocks/dev-tunnel-session';

/**
 * GET/ANY /api/internal/dev-tunnel-gate  (APP DEV TUNNEL — edge forwardAuth)
 *
 * A Traefik `forwardAuth` target guarding the ephemeral dev-tunnel hosts
 * (`dev-<16hex>.<APPS_DOMAIN>`). This is the author-bound sibling of the mod
 * review-sandbox gate (`/api/internal/mod-gate`): the dev-tunnel host is a
 * CROSS-ORIGIN iframe embedded inside the authenticated `civitai.com/apps/dev`
 * page, so the civitai session cookie is NOT sent to `*.civit.ai`. The already-
 * authenticated parent mints a signed, short-TTL, AUTHOR-bound ENTRY token (see
 * `dev-tunnel-session.ts`) and injects it into the iframe `src` as `?dev=<token>`.
 *
 * ── LOAD-BEARING INVARIANT (T3) ──
 * A NAKED request to `dev-<host>.<APPS_DOMAIN>` with NO / expired / wrong-user /
 * host-mismatched token is DENIED (401) BEFORE it can reach the tunnel → the dev's
 * localhost is never exposed to an unauthenticated visitor. The `dev-<16hex>` host
 * is itself a ~64-bit secret on top of this gate (defence for T1).
 *
 * ── ENTRY-GATE-ONLY (mirrors mod-gate exactly) ──
 * Authorizes ONLY the ENTRY document/iframe request (the one that can carry the
 * `dev` token) and ALLOWS subresources through — Traefik does not forward a 2xx
 * auth response's Set-Cookie, so a per-subresource cookie gate can't be set (the
 * documented review-sandbox tradeoff). Residual risk is the same + accepted: the
 * token gates the ENTRY document, and the host is an unguessable ephemeral secret.
 *
 *   - ENTRY (Sec-Fetch-Dest document/iframe/frame/nested-document, OR ABSENT →
 *     treated as entry, fail-safe): require a valid `dev` token bound to
 *     X-Forwarded-Host → 200 + X-Dev-User-Id, else 401.
 *   - SUBRESOURCE (any other Sec-Fetch-Dest): 200 (allow).
 *   - Missing X-Forwarded-Host → 401 (fail-closed).
 */

/** Sec-Fetch-Dest values that mean "top-level document / iframe being LOADED". An
 *  ABSENT header is treated as entry (fail-safe). */
const ENTRY_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document']);

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Extract the `dev` query param from the forwarded original URI. */
function extractDevToken(forwardedUri: string | undefined): string | undefined {
  if (!forwardedUri) return undefined;
  const q = forwardedUri.indexOf('?');
  if (q < 0) return undefined;
  try {
    const params = new URLSearchParams(forwardedUri.slice(q + 1));
    return params.get('dev') ?? undefined;
  } catch {
    return undefined;
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const forwardedUri = firstHeader(req.headers['x-forwarded-uri']);
  const secFetchDest = firstHeader(req.headers['sec-fetch-dest']);

  // Fail-closed: without the dev host we can't bind/verify anything.
  if (!forwardedHost) {
    res.status(401).json({ error: 'Missing dev host' });
    return;
  }

  // SUBRESOURCE → allow (see the header comment: the 2xx Set-Cookie subresource
  // gate can't be set, accepted tradeoff — the ENTRY `dev` token still keeps
  // unauthenticated visitors out).
  const isEntry = secFetchDest == null || ENTRY_DESTS.has(secFetchDest);
  if (!isEntry) {
    res.status(200).json({ ok: true, via: 'subresource' });
    return;
  }

  // ENTRY → require a valid `dev` token bound to this host.
  const token = extractDevToken(forwardedUri);
  const result = verifyDevTunnelAccessToken(token, forwardedHost);
  if (result.ok && result.userId != null) {
    res.setHeader('X-Dev-User-Id', String(result.userId));
    res.status(200).json({ ok: true, via: 'token' });
    return;
  }

  // Naked / invalid / expired / wrong-user / host-mismatched token → 401. T3.
  res.status(401).json({ error: 'Dev tunnel session required' });
}
