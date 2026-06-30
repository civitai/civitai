import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { verifyReviewAccessToken } from '~/server/services/blocks/review-session';

/**
 * GET/ANY /api/internal/mod-gate  (MOD REVIEW SANDBOX, #2831)
 *
 * A Traefik `forwardAuth` target guarding the temporary review-preview hosts
 * (`review-<sha16>.<APPS_DOMAIN>`). The review preview is a CROSS-ORIGIN iframe
 * embedded inside the authenticated civitai.com `/apps/review` page.
 *
 * ── TOKEN ENTRY GATE (replaces the cross-domain cookie that could never work) ──
 * The civitai session cookie is scoped to civitai.com and is NOT sent to a
 * `*.civit.ai` host, so resolving the session from the forwarded Cookie 401'd
 * EVERYONE. Instead the already-authenticated civitai.com parent page mints a
 * signed, short-TTL, mod-bound token (see `review-session.ts`) and injects it
 * into the iframe `src` as `?mr=<token>`. THIS gate verifies that token on the
 * ENTRY (document/iframe) request:
 *   - valid `mr` token whose bound host == `X-Forwarded-Host` → 200 + `X-Mod-Id`
 *     (the existing authResponseHeaders contract is preserved),
 *   - otherwise → 401 (fail-closed).
 *
 * ── ENTRY vs SUBRESOURCE ──
 * Traefik forwardAuth mirrors the original request headers, so we read
 * `Sec-Fetch-Dest` (the browser's request destination):
 *   - ENTRY  = `document` / `iframe`, OR the header is ABSENT (treated as entry,
 *     fail-safe) → a valid `mr` token is REQUIRED.
 *   - SUBRESOURCE = any other Sec-Fetch-Dest (`script`/`style`/`image`/`font`/
 *     `fetch`/`empty` (XHR)/etc.) → allowed (200). Subresources carry no `mr`
 *     query param of their own and the browser does NOT replay the entry URL's
 *     query string onto them, so gating them on the token would break every
 *     asset load. The ACCESS CONTROL is the entry gate: the preview can only be
 *     LOADED with a mod-minted token; the rendered subresources are undiscoverable
 *     without that gated entry and are pending-public block code anyway.
 *
 * NOTE (NOT implemented): full per-subresource gating is possible with a CHIPS
 * `Partitioned` cookie set on the 200 entry response (so the browser replays a
 * partitioned, `*.civit.ai`-scoped cookie on subresources) — Chrome/Firefox only.
 * Deliberately left out: the entry gate is sufficient and the token approach has
 * no cross-domain cookie dependency.
 *
 * No body is read and no method is enforced: Traefik forwardAuth issues a GET by
 * default but may mirror the original method, so we accept any method.
 */

/** Sec-Fetch-Dest values that mean "this is the top-level document / iframe being
 *  LOADED" (an entry request that must carry the mod token). Everything else is a
 *  subresource. An ABSENT header is treated as entry (fail-safe). */
const ENTRY_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document']);

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Extract the `mr` query param from the forwarded original URI (X-Forwarded-Uri
 *  is path?query). Returns undefined if absent / unparseable. */
function extractMrToken(forwardedUri: string | undefined): string | undefined {
  if (!forwardedUri) return undefined;
  const q = forwardedUri.indexOf('?');
  if (q < 0) return undefined;
  try {
    const params = new URLSearchParams(forwardedUri.slice(q + 1));
    return params.get('mr') ?? undefined;
  } catch {
    return undefined;
  }
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Traefik forwardAuth mirrors the original request headers (lowercased by Node).
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const forwardedUri = firstHeader(req.headers['x-forwarded-uri']);
  const secFetchDest = firstHeader(req.headers['sec-fetch-dest']);

  // SUBRESOURCE (script/style/image/font/fetch/empty/…): allow. The entry gate is
  // the access control; see the header comment for the rationale + the CHIPS
  // upgrade option.
  const isEntry = secFetchDest == null || ENTRY_DESTS.has(secFetchDest);
  if (!isEntry) {
    res.status(200).json({ ok: true, subresource: true });
    return;
  }

  // ENTRY (document/iframe, or absent header): require a valid mod-minted token
  // whose bound host matches the review host being loaded. Fail-closed on any
  // missing piece.
  if (!forwardedHost) {
    res.status(401).json({ error: 'Missing review host' });
    return;
  }
  const token = extractMrToken(forwardedUri);
  const result = verifyReviewAccessToken(token, forwardedHost);
  if (!result.ok || result.modUserId == null) {
    res.status(401).json({ error: 'Moderator review token required' });
    return;
  }

  // Surface the mod identity so Traefik can forward it upstream via
  // authResponseHeaders (preserves the prior contract).
  res.setHeader('X-Mod-Id', String(result.modUserId));
  res.status(200).json({ ok: true });
});
