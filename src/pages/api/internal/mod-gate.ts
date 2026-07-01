import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { verifyReviewAccessToken } from '~/server/services/blocks/review-session';

/**
 * GET/ANY /api/internal/mod-gate  (MOD REVIEW SANDBOX, #2831 / #2847 / #2855)
 *
 * A Traefik `forwardAuth` target guarding the temporary review-preview hosts
 * (`review-<sha16>.<APPS_DOMAIN>`). The review preview is a CROSS-ORIGIN iframe
 * embedded inside the authenticated civitai.com `/apps/review` page.
 *
 * ── WHY A TOKEN, NOT THE SESSION COOKIE ──
 * The civitai session cookie is scoped to civitai.com and is NOT sent to a
 * `*.civit.ai` host, so resolving the civitai session from the forwarded Cookie
 * 401'd EVERYONE. Instead the already-authenticated civitai.com parent page
 * mints a signed, short-TTL (120s), mod-bound ENTRY token (see
 * `review-session.ts`) and injects it into the iframe `src` as `?mr=<token>`.
 *
 * ── ENTRY-GATE-ONLY (this is the current design) ──
 * This gate authorizes ONLY the ENTRY document/iframe request (the one that can
 * carry the `mr` token) and ALLOWS every subresource (script/style/image/font/
 * fetch/empty/…) through unauthenticated:
 *
 *   - ENTRY request (Sec-Fetch-Dest document/iframe/frame/nested-document, OR
 *     the header ABSENT — treated as entry, fail-safe): require a valid `mr`
 *     token whose bound host === X-Forwarded-Host → 200 + `X-Mod-Id`, else 401.
 *   - SUBRESOURCE request (any other Sec-Fetch-Dest): 200 (allow).
 *   - Missing X-Forwarded-Host → 401 (fail-closed; can't bind/verify anything).
 *
 * ── WHY THE CHIPS SUBRESOURCE-COOKIE GATE WAS REVERTED ──
 * The earlier #2847 hardening tried to gate EVERY subresource with a CHIPS
 * `Partitioned` session cookie: on a valid `mr` entry, the gate returned 200
 * WITH a `Set-Cookie: __Host-review-sess=...; Partitioned; SameSite=None` so the
 * browser would replay that cookie on subsequent subresource requests, and each
 * subresource would then be verified against it.
 *
 * That does NOT work: **Traefik `forwardAuth` does not forward a 2xx auth
 * response's `Set-Cookie` header back to the client** (confirmed live — an entry
 * request with a valid token returns 200 with NO Set-Cookie reaching the
 * browser). So the CHIPS session cookie is never set, and every subsequent
 * subresource arrives with no cookie → 401 → the review preview never renders.
 * The subresource-cookie gate was therefore REVERTED to this entry-gate-only
 * design.
 *
 * ── ACCEPTED TRADEOFF ──
 * Subresources are served WITHOUT per-request auth. The residual risk is low and
 * accepted:
 *   - The `mr` token still gates the ENTRY document, so a non-mod cannot LOAD the
 *     preview page at all.
 *   - The `review-<sha16>` host is a ~64-bit secret (the sha16 hostname) surfaced
 *     ONLY to mods. It is mod-only, ephemeral, and exists purely for the
 *     pre-approval preview — an attacker who does not already know the exact host
 *     can't request its subresources, and the host is torn down after review.
 *
 * ── FUTURE HARDENING (if per-subresource gating is ever wanted) ──
 * A **302-strip handshake** would restore subresource gating without depending on
 * 2xx Set-Cookie forwarding: on a valid `mr` token, mod-gate returns a `302` to
 * the SAME URL minus the `mr` param, WITH the `Set-Cookie` on the redirect —
 * Traefik DOES forward headers (incl. Set-Cookie) on a NON-2xx auth response, so
 * the CHIPS cookie is set via the redirect; the browser then re-requests the
 * document (now cookie-carrying) and subsequent subresources carry the cookie
 * too. This is still CHIPS-only (Chromium/Firefox; Safari hard-blocks the
 * `Partitioned` cookie so it would be excluded). NOT implemented — documented as
 * a known lever.
 *
 * No body is read and no method is enforced: Traefik forwardAuth issues a GET by
 * default but may mirror the original method, so we accept any method.
 */

/** Sec-Fetch-Dest values that mean "this is the top-level document / iframe being
 *  LOADED" (an entry request that may carry the mod `mr` token). Everything else
 *  is a subresource. An ABSENT header is treated as entry (fail-safe). */
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

  // Fail-closed: without the review host we can't bind/verify anything.
  if (!forwardedHost) {
    res.status(401).json({ error: 'Missing review host' });
    return;
  }

  // SUBRESOURCE (any Sec-Fetch-Dest that is NOT an entry dest) → allow. See the
  // header comment: the CHIPS subresource-cookie gate can't be set (Traefik
  // doesn't forward the 2xx Set-Cookie), so subresources are served without
  // per-request auth (accepted tradeoff — the `mr` gate on the ENTRY document
  // still keeps non-mods out of the preview).
  const isEntry = secFetchDest == null || ENTRY_DESTS.has(secFetchDest);
  if (!isEntry) {
    res.status(200).json({ ok: true, via: 'subresource' });
    return;
  }

  // ENTRY (document/iframe/frame/nested-document, or ABSENT Sec-Fetch-Dest which
  // is treated as entry, fail-safe) → require a valid `mr` token bound to this host.
  const token = extractMrToken(forwardedUri);
  const result = verifyReviewAccessToken(token, forwardedHost);
  if (result.ok && result.modUserId != null) {
    res.setHeader('X-Mod-Id', String(result.modUserId));
    res.status(200).json({ ok: true, via: 'token' });
    return;
  }

  // Entry with no/invalid/expired/forged/host-mismatched token → 401. Fail-closed.
  res.status(401).json({ error: 'Moderator review session required' });
});
