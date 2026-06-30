import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import {
  REVIEW_SESSION_COOKIE_TTL_SECONDS,
  signReviewSessionCookie,
  verifyReviewAccessToken,
  verifyReviewSessionCookie,
} from '~/server/services/blocks/review-session';

/**
 * GET/ANY /api/internal/mod-gate  (MOD REVIEW SANDBOX, #2831 / #2847)
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
 * ── FULL SUBRESOURCE GATING (the #2847 hardening) ──
 * The earlier design gated ONLY the entry document and ALLOWED every subresource
 * (`Sec-Fetch-Dest != document` → 200). That was a SPOOF HOLE: a raw client could
 * send `Sec-Fetch-Dest: image` (or any non-document value) with no token and pull
 * the unapproved block bundle. This gate closes it with a CHIPS `Partitioned`
 * session cookie:
 *
 *   1. SESSION COOKIE PRESENT (`__Host-review-sess`) and valid for this host →
 *      200 + `X-Mod-Id`. Covers BOTH the entry document AND every subresource,
 *      because the browser replays the partitioned cookie on same-host requests.
 *
 *   2. Else ENTRY (`Sec-Fetch-Dest` document/iframe/frame/nested-document OR
 *      absent) with a valid `mr` token (host match) → 200 + `X-Mod-Id` AND a
 *      `Set-Cookie: __Host-review-sess=...; SameSite=None; Secure; HttpOnly;
 *      Partitioned; Max-Age=1800` so subsequent subresources carry the cookie.
 *
 *   3. Else (a subresource with no/invalid cookie, OR an entry with no/invalid
 *      token) → 401. Fail-closed.
 *
 * The cookie is `__Host-`-prefixed with NO `Domain` attribute, so it is
 * host-locked to the exact `review-<sha16>.civit.ai` it was set on (a sibling
 * review host can't read it). `Partitioned` + `SameSite=None` + `Secure` = CHIPS,
 * required for the cookie to be stored/replayed inside the cross-site iframe.
 *
 * ── DEPENDENCY: Traefik forwardAuth Cookie / Set-Cookie forwarding (CONFIRM ON CLUSTER) ──
 * This design relies on Traefik forwardAuth:
 *   (a) FORWARDING the inbound request `Cookie` header to this endpoint (so we
 *       can read `__Host-review-sess` on subresource requests), and
 *   (b) FORWARDING this endpoint's `Set-Cookie` header from the 2xx auth response
 *       back to the browser on the entry response.
 * Both are the STANDARD forwardAuth behavior (it's exactly how oauth2-proxy's
 * forwardAuth integration sets its session cookie), but (b) in particular is the
 * ONE wiring assumption that cannot be exercised without the live cluster — it
 * MUST be confirmed on-cluster before flipping the feature flag. If Traefik does
 * NOT forward Set-Cookie on a 2xx auth response, the FALLBACK is a 302-strip
 * handshake: the gate, on a valid entry token, 302-redirects to the SAME URL with
 * the `mr` param stripped and the `Set-Cookie` on the 302 (Traefik forwards
 * Set-Cookie on auth redirects); the browser then re-requests the document
 * carrying the cookie. That fallback is NOT implemented here (it adds a redirect
 * round-trip and isn't needed if (b) holds) — documented so it's a known lever.
 *
 * ── SAFARI LIMITATION (accepted tradeoff) ──
 * Safari does NOT support CHIPS / the `Partitioned` cookie attribute and hard-
 * blocks third-party cookies, so the session cookie is NOT stored inside the
 * cross-site iframe → every subresource request arrives with no cookie → 401 →
 * the preview is BROKEN in Safari. Review previews therefore require a
 * Chromium- or Firefox-based browser. This tradeoff was accepted (full
 * subresource gating > Safari compatibility for a mod-only review tool).
 *
 * No body is read and no method is enforced: Traefik forwardAuth issues a GET by
 * default but may mirror the original method, so we accept any method.
 */

/** Sec-Fetch-Dest values that mean "this is the top-level document / iframe being
 *  LOADED" (an entry request that may carry the mod `mr` token). Everything else
 *  is a subresource. An ABSENT header is treated as entry (fail-safe). */
const ENTRY_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document']);

/** Cookie name. `__Host-` prefix REQUIRES Secure + Path=/ + NO Domain → the
 *  browser host-locks it to the exact review host (sibling hosts can't read it). */
const SESSION_COOKIE_NAME = '__Host-review-sess';

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

/** Parse the `__Host-review-sess` value out of a forwarded `Cookie` header.
 *  Returns undefined if absent / unparseable. Does its own minimal cookie-pair
 *  split (no library) so the gate stays dependency-light. */
function extractSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      const raw = part.slice(eq + 1).trim();
      if (!raw) return undefined;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

/** Build the `Set-Cookie` header value for the CHIPS partitioned session cookie.
 *  `__Host-` + Path=/ + no Domain (host-lock) · Secure · HttpOnly · SameSite=None
 *  + Partitioned (CHIPS, so it's stored/replayed inside the cross-site iframe). */
function buildSessionSetCookie(value: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=None',
    'Partitioned',
    `Max-Age=${REVIEW_SESSION_COOKIE_TTL_SECONDS}`,
  ].join('; ');
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Traefik forwardAuth mirrors the original request headers (lowercased by Node).
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const forwardedUri = firstHeader(req.headers['x-forwarded-uri']);
  const secFetchDest = firstHeader(req.headers['sec-fetch-dest']);
  const cookieHeader = firstHeader(req.headers['cookie']);

  // Fail-closed: without the review host we can't bind/verify anything.
  if (!forwardedHost) {
    res.status(401).json({ error: 'Missing review host' });
    return;
  }

  // 1) SESSION COOKIE path — authorizes BOTH the entry document AND subresources.
  //    Checked first so an established session never depends on Sec-Fetch-Dest.
  const sessionCookie = extractSessionCookie(cookieHeader);
  if (sessionCookie) {
    const sess = verifyReviewSessionCookie(sessionCookie, forwardedHost);
    if (sess.ok && sess.modUserId != null) {
      res.setHeader('X-Mod-Id', String(sess.modUserId));
      res.status(200).json({ ok: true, via: 'session' });
      return;
    }
    // Invalid/expired/host-mismatched cookie → fall through to the entry/token
    // path (an entry request with a stale cookie can re-establish via its token).
  }

  // 2) ENTRY path — a valid `mr` token mints the session cookie. An ABSENT
  //    Sec-Fetch-Dest is treated as entry (fail-safe).
  const isEntry = secFetchDest == null || ENTRY_DESTS.has(secFetchDest);
  if (isEntry) {
    const token = extractMrToken(forwardedUri);
    const result = verifyReviewAccessToken(token, forwardedHost);
    if (result.ok && result.modUserId != null) {
      // Mint the CHIPS partitioned session cookie so EVERY subsequent
      // subresource is gated too (closes the Sec-Fetch-Dest spoof hole). Relies
      // on Traefik forwarding this Set-Cookie on the 2xx auth response — see the
      // header comment (must be confirmed on-cluster).
      const cookieValue = signReviewSessionCookie({
        modUserId: result.modUserId,
        host: forwardedHost,
      });
      res.setHeader('Set-Cookie', buildSessionSetCookie(cookieValue));
      res.setHeader('X-Mod-Id', String(result.modUserId));
      res.status(200).json({ ok: true, via: 'token' });
      return;
    }
  }

  // 3) Else (subresource with no/invalid cookie, OR entry with no/invalid token)
  //    → 401. This is the closed spoof hole: a `Sec-Fetch-Dest: image` (or any
  //    subresource) request with no valid session cookie is now REJECTED.
  res.status(401).json({ error: 'Moderator review session required' });
});
