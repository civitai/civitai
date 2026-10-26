/**
 * RUM page attributes — tag every Faro RUM beacon of a document with two facts about THAT
 * DOCUMENT'S HARD LOAD, so web-vitals (LCP, CLS, INP, FCP, TTFB) can be split by them:
 *   - `render_mode` = `shell` | `ssr`: the route's cached static shell (see
 *     `~/server/shell/shell-mode`) or the normal per-viewer server render.
 *   - `viewer` = `signed-in` | `anon`: whether the hard load was made with a session. No
 *     identity — only the two literals.
 *
 * WHY NOT SESSION ATTRIBUTES (like experimentFlags.ts / geoAttributes.ts):
 *   1. A Faro session spans many hard loads, and a RESUMED session keeps the attributes STORED
 *      at its creation over the ones passed to `initializeFaro` (web-sdk `SessionInstrumentation`
 *      `createInitialSession`: stored attributes are merged last). Both facts can differ per hard
 *      load, so as session attributes they would carry the FIRST load's values for the whole tab.
 *   2. Neither may be derived from feature flags or the session as the client sees it at init. A
 *      shell render is one HTML for every viewer, seeded with flags evaluated with no user and no
 *      session; the viewer's real ones only arrive with the page data. The inputs are what `_app`
 *      knows about THIS document at its first render, frozen there:
 *      - `shell`: the shell-only `pageProps.shell` marker (`bootedShell`).
 *      - `signedIn`: the hard load's `pageProps.session` or `pageProps.hasAuthCookie`. A full
 *        render sets `hasAuthCookie` only when the session lookup failed with a cookie present
 *        (not known to be anonymous). A shell is only ever served to a request carrying a session
 *        cookie (`shellRefusal` → `no-session-cookie`) and its pageProps say `hasAuthCookie: true`,
 *        so every shell load is `signed-in`; a dead cookie's page data answers 404 and the page
 *        reloads as a full render, which is a new document with its own value.
 *
 * MECHANISM + THE LOKI FIELDS IT PRODUCES:
 *   - Passed to `initializeFaro` as `pageTracking.page.attributes`. The web-sdk's page meta getter
 *     re-evaluates on every beacon as `{ url: location.href, ...initialPageMeta }`, so the URL
 *     stays live while the attributes ride on `meta.page.attributes` of every beacon from init
 *     onward (before any web-vitals beacon: the instrumentations start during init).
 *     (`faro.api.setPage(object)` is NOT used: it replaces the whole page meta, freezing the URL.)
 *   - Alloy's `faro.receiver` maps page meta with prefix `page_` and its `attributes` with prefix
 *     `attr_`, so these land as the logfmt fields **`page_attr_render_mode`** and
 *     **`page_attr_viewer`**.
 *
 * SCOPE: one value per DOCUMENT, unchanged by client-side navigations. That is deliberate: the
 * web-vitals library measures the hard-loaded document, not a route — CLS and INP are reported
 * once, at page hide, covering every client-side navigation the document went through, and the
 * page URL on such a beacon is wherever the user was at hide time. Re-tagging on navigation would
 * file a shell document's CLS/INP under `ssr`. Read the fields as "this beacon comes from a
 * document whose hard load was …", not as facts about the current route or session.
 *
 * PII/SAFETY: four literal values, nothing user-identifying; they match none of the `deepRedact`
 * patterns, so they pass the `beforeSend` scrub unchanged (pinned in the unit test).
 *
 * PURE + unit-tested (`__tests__/pageAttributes.test.ts`).
 */

/** Whether the hard load was made with a session, from its pageProps (see the header). */
export function isHardLoadSignedIn(pageProps: { session?: unknown; hasAuthCookie?: boolean }) {
  return !!pageProps.session || pageProps.hasAuthCookie === true;
}

export function buildRumPageAttributes({
  shell,
  signedIn,
}: {
  shell: boolean;
  signedIn: boolean;
}): { render_mode: 'shell' | 'ssr'; viewer: 'signed-in' | 'anon' } {
  return {
    render_mode: shell ? 'shell' : 'ssr',
    viewer: signedIn ? 'signed-in' : 'anon',
  };
}
