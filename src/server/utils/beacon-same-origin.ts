/**
 * The same-origin guard the telemetry beacons use.
 *
 * Lifted VERBATIM from the three beacons that already ship it — `src/pages/api/internal/pulse.ts`,
 * `src/pages/api/track/block-render.ts` and `src/pages/api/track/batch.ts` — whose own comments call
 * it "the established beacon pattern". Extracted rather than copied a fourth time so the predicate
 * has one spelling and one test suite. The three existing call sites still open-code it; replacing
 * their copies with this function is a behaviour-preserving change to the busiest endpoint in the
 * app and belongs in its own reviewable commit, not here.
 *
 * WHAT IT ASSERTS: the request was issued by a document this app itself served. A browser sets
 * `Origin` on every `fetch()` whose method is not GET/HEAD, and a caller that posts a RELATIVE path
 * — which every in-app beacon does — necessarily produces an `Origin` whose host is the very host
 * the request is then routed to. So for a real in-app beacon the two sides of the comparison are
 * the same string by construction, on ANY host the app is served from. The guard enumerates no
 * domain and therefore cannot single one out: adding or renaming a served host changes nothing
 * here.
 *
 * `Referer` is the fallback for clients that suppress `Origin`, matching the three siblings.
 *
 * 🔴 A REQUEST CARRYING NEITHER HEADER IS REJECTED, not allowed. That is deliberate and it is where
 * the guard gets its strength — an allow-on-absent rule is satisfied by sending nothing at all, so
 * it would bound no one. The cost of the strict direction is that a caller which is not a browser
 * document gets a 400; the three siblings have run exactly this rule in production for a long time
 * at high volume, so the size of that population is measurable rather than hypothetical.
 *
 * NOT AN AUTHENTICATION BOUNDARY. `Origin` is set by the browser and omitted or forged freely by a
 * non-browser client. What it buys is that the trivial path — a request that is not from a page of
 * ours — does not reach the work behind it. Never put something behind this that needs a real
 * identity.
 */
export function isSameOriginBeacon(req: {
  headers: { origin?: string; referer?: string; host?: string };
}): boolean {
  const source = req.headers.origin ?? req.headers.referer;
  const sourceHost = source
    ? (() => {
        try {
          return new URL(source).host;
        } catch {
          // A malformed-but-present header (bot and scraper traffic sends these) must land on the
          // same rejection as a mismatch rather than throwing out of the handler.
          return undefined;
        }
      })()
    : undefined;
  return !!sourceHost && sourceHost === req.headers.host;
}
