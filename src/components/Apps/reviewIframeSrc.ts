/**
 * MOD REVIEW SANDBOX (#2831) — stable iframe-src selection for the live review
 * preview.
 *
 * `blocks.getReviewStatus` mints a FRESH `?mr=<token>` previewUrl on every poll
 * (the token `exp` advances each time). If the iframe `src` were bound straight
 * to the latest `previewUrl`, the iframe would hard-reload on every poll (now
 * 60s with the slow live-poll) — wiping any in-progress interaction in the
 * previewed block (scroll, form input, an in-flight generation).
 *
 * `pickReviewIframeSrc` decouples the iframe src from the poll: it KEEPS the
 * currently-embedded src untouched while the token it carries still has
 * comfortable validity, and only swaps to a fresh token when there's no current
 * src yet OR the embedded token is within the refresh window of expiry. Net: the
 * iframe holds a stable src for ~90s, then swaps once to a fresh token — no
 * per-minute reload.
 *
 * PURE — no DOM, no crypto. Decodes only the (already-public) `exp` claim from
 * the token's base64url payload; it does not verify the signature (the mod-gate
 * forwardAuth does that on the entry request).
 */

/** Token TTL is 120s (see review-session.ts REVIEW_ACCESS_TOKEN_TTL_SECONDS).
 *  Swap once the embedded token has fewer than this many ms of validity left,
 *  so we never embed a token that could expire mid-load. */
export const REVIEW_IFRAME_SRC_REFRESH_MS = 30_000;

/** base64url → base64 (restore +,/ and re-pad) so it can be decoded. */
function base64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const padded = b64 + pad;
  // atob in the browser; Buffer in node (tests/SSR). Prefer atob when present.
  if (typeof atob === 'function') {
    return atob(padded);
  }
  return Buffer.from(padded, 'base64').toString('binary');
}

/**
 * Decode the `exp` (unix SECONDS) from the `mr` token embedded in a preview URL.
 * Returns null when the URL has no `mr` token, the token is malformed, or the
 * payload can't be parsed / lacks a numeric `exp`. A null result is treated by
 * callers as "expired" → swap.
 */
export function readReviewTokenExpMs(src: string | undefined): number | null {
  if (!src) return null;
  let token: string | null = null;
  // Pull the `mr` query param without needing a base URL (src may be relative).
  const q = src.indexOf('?');
  if (q === -1) return null;
  const search = src.slice(q + 1).split('#')[0];
  for (const pair of search.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === 'mr') {
      token = decodeURIComponent(pair.slice(eq + 1));
      break;
    }
  }
  if (!token) return null;

  // Wire form: base64url(json({m,h,exp})).base64url(sig) — payload is segment 0.
  const dot = token.indexOf('.');
  const payloadB64 = dot === -1 ? token : token.slice(0, dot);
  try {
    const json = base64urlToString(payloadB64);
    const parsed = JSON.parse(json) as { exp?: unknown };
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null;
    return parsed.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Choose the iframe `src` for the live review preview.
 *
 *  - No current src yet → use the latest previewUrl (first mount).
 *  - Current token still has comfortable validity (> refresh window) → keep the
 *    current src UNCHANGED, even if a newer previewUrl is available. This is the
 *    point: the iframe does not reload on every poll.
 *  - Current token is within the refresh window / expired / unparseable → swap
 *    to the latest previewUrl (a single fresh-token swap), falling back to the
 *    current src if no latest is available.
 */
export function pickReviewIframeSrc(
  currentSrc: string | undefined,
  latestPreviewUrl: string | undefined,
  nowMs: number,
  refreshMs: number = REVIEW_IFRAME_SRC_REFRESH_MS
): string {
  if (!currentSrc) return latestPreviewUrl ?? '';

  const expMs = readReviewTokenExpMs(currentSrc);
  // Unparseable / no exp → treat as expired → swap.
  if (expMs === null) return latestPreviewUrl ?? currentSrc;

  const remainingMs = expMs - nowMs;
  if (remainingMs > refreshMs) {
    // Plenty of validity left — keep the stable src, ignore the newer token.
    return currentSrc;
  }
  // Near expiry — swap to the fresh token (or keep current if none available).
  return latestPreviewUrl ?? currentSrc;
}
