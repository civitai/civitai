/**
 * RUM render-mode page attribute — tag every Faro RUM beacon of a document with HOW THAT
 * DOCUMENT'S HARD LOAD WAS RENDERED: the route's cached static shell (`shell`, see
 * `~/server/shell/shell-mode`) or the normal per-viewer server render (`ssr`). This makes
 * web-vitals (LCP, CLS, INP, FCP, TTFB) splittable by render mode.
 *
 * WHY NOT A SESSION ATTRIBUTE (like experimentFlags.ts / geoAttributes.ts):
 *   1. A Faro session spans many hard loads, and a RESUMED session keeps the attributes STORED
 *      at its creation over the ones passed to `initializeFaro` (web-sdk `SessionInstrumentation`
 *      `createInitialSession`: stored attributes are merged last). Render mode differs per hard
 *      load, so as a session attribute it would carry the FIRST load's value for the whole tab.
 *   2. It must not be derived from a feature flag. A shell render is one HTML for every viewer,
 *      seeded with flags evaluated with no user; the viewer's real flags only replace them when
 *      the page data arrives. What tells the client it is looking at a shell is the shell-only
 *      `pageProps.shell` marker `_app.getInitialProps` writes into THIS document — `_app` freezes
 *      it as `bootedShell` and FaroProvider passes it in here.
 *
 * MECHANISM + THE LOKI FIELD IT PRODUCES:
 *   - Passed to `initializeFaro` as `pageTracking.page.attributes`. The web-sdk's page meta getter
 *     re-evaluates on every beacon as `{ url: location.href, ...initialPageMeta }`, so the URL
 *     stays live while the attribute rides on `meta.page.attributes` of every beacon from init
 *     onward (before any web-vitals beacon: the instrumentations start during init).
 *     (`faro.api.setPage(object)` is NOT used: it replaces the whole page meta, freezing the URL.)
 *   - Alloy's `faro.receiver` maps page meta with prefix `page_` and its `attributes` with prefix
 *     `attr_`, so this lands as the logfmt field **`page_attr_render_mode`** = `shell` | `ssr`.
 *
 * SCOPE: one value per DOCUMENT, unchanged by client-side navigations. That is deliberate: the
 * web-vitals library measures the hard-loaded document, not a route — CLS and INP are reported
 * once, at page hide, covering every client-side navigation the document went through, and the
 * page URL on such a beacon is wherever the user was at hide time. Re-tagging on navigation would
 * file a shell document's CLS/INP under `ssr`. Read the field as "this beacon comes from a
 * document whose hard load was rendered as …", not as "the current route is a shell".
 *
 * PII/SAFETY: two literal values, nothing user-identifying; they match none of the `deepRedact`
 * patterns, so they pass the `beforeSend` scrub unchanged (pinned in the unit test).
 */

/** Page-attribute key → Loki field `page_attr_render_mode`. */
export const RUM_RENDER_MODE_ATTR = 'render_mode';

export type RumRenderMode = 'shell' | 'ssr';

/**
 * The render mode of the hard load, from `_app`'s `pageProps.shell` marker. Only a literal `true`
 * is a shell: the marker is absent on every full render, and anything else is not the shell's.
 *
 * PURE + unit-tested (`__tests__/renderMode.test.ts`).
 */
export function resolveRumRenderMode(shell: unknown): RumRenderMode {
  return shell === true ? 'shell' : 'ssr';
}

/** The page attributes FaroProvider sets at init. */
export function buildRumPageAttributes(shell: unknown): Record<string, string> {
  return { [RUM_RENDER_MODE_ATTR]: resolveRumRenderMode(shell) };
}
