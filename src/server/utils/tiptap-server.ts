/**
 * Leak-free server-side wrapper around `@tiptap/html`'s `generateJSON`.
 *
 * Why this exists
 * ---------------
 * `@tiptap/html/server`'s `generateJSON` constructs a fresh `happy-dom`
 * `Window` per call but never disposes of it. happy-dom registers every
 * `Window` it creates in a module-level static
 * `WindowBrowserContext.browserFrames` Map, keyed by an internal id, and
 * only removes the entry when the window is explicitly closed. Without
 * disposal, every parsed article retains an entire `BrowserWindow`,
 * `Document`, `<head>`, link sheets, `CSSStyleRule` arrays, and any
 * embedded iframe payloads (YouTube embeds in the article path each pull
 * in ~11 MiB of JS source).
 *
 * Confirmed in production via V8 heap snapshot of an SSR pod (2026-05-15):
 * the retainer chain on every leaked `CSSStyleRule` bottoms out at
 *   Global handles
 *    → ModuleWrap (happy-dom WindowBrowserContext.js)
 *     → static `browserFrames` Map
 *      → DetachedBrowserFrame
 *       → BrowserWindow
 *        → HTMLHeadElement / link sheets / CSSStyleRule[]
 * with 45,332 retained `CSSStyleRule`s and 14 duplicate copies of the
 * YouTube embed JS (~79 MiB just from those copies) at 2.4h pod uptime.
 *
 * The fix
 * -------
 * Reimplement `generateJSON` locally — the upstream body is ~10 lines —
 * and call `localWindow.happyDOM.close()` in a `finally` block (fire-and-
 * forget; see "Why not await" below). `happyDOM.close()` triggers the
 * destroy chain in `BrowserWindow` which calls
 * `WindowBrowserContext.removeWindowBrowserFrameRelation(this)` and frees
 * the entry from the static `browserFrames` Map. This matches happy-dom's
 * documented disposal contract.
 *
 * Cleanup timing
 * --------------
 * For content with no iframes, the destroy chain runs synchronously inside
 * the `Promise` constructor in `BrowserFrameFactory.destroyFrame`, so the
 * Map entry is gone before `close()` returns. For content with iframes
 * (e.g. YouTube embeds — which are exactly what bloated the heap pre-fix),
 * the parent window's destroy runs in `.then(...)` after `Promise.all`
 * over children — i.e. one microtask later, not synchronously. In either
 * case, microtasks drain before the next SSR request lands, so the Map is
 * empty across requests; entries never accumulate.
 *
 * Why not await
 * -------------
 * Awaiting would close the iframe-path microtask gap, but at the cost of
 * making `generateJSON` async and propagating `await` to every callsite.
 * Since the gap is bounded by one microtask drain (not by I/O) and never
 * spans requests, the sync-API ergonomics win. We `void` the promise and
 * `.catch(() => {})` so an unlikely close() rejection doesn't surface as
 * an unhandled rejection.
 *
 * Upstream issue family on tiptap + happy-dom: see happy-dom GitHub
 * issues referencing "WindowBrowserContext" / "browserFrames" memory
 * leaks, e.g. happy-dom/happy-dom#1271 and the longer thread of
 * downstream "tiptap server-side renders leak" reports.
 */
import { getSchema, type Extensions } from '@tiptap/core';
import { DOMParser as PMDOMParser, type ParseOptions } from '@tiptap/pm/model';
import { Window } from 'happy-dom';

// Return type matches `@tiptap/html/server`'s `generateJSON` exactly so this
// is a drop-in replacement at every callsite (some callers assign the result
// to a narrower local type and rely on `any` flowing through).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateJSON(
  html: string,
  extensions: Extensions,
  options?: ParseOptions
): Record<string, any> {
  if (typeof window !== 'undefined') {
    throw new Error('generateJSON (server wrapper) can only be used in a Node environment');
  }

  const localWindow = new Window();
  try {
    const localDOMParser = new localWindow.DOMParser();
    const schema = getSchema(extensions);
    const htmlString = `<!DOCTYPE html><html><body>${html}</body></html>`;
    const doc = localDOMParser.parseFromString(htmlString, 'text/html');
    if (!doc) {
      throw new Error('Failed to parse HTML string');
    }
    // Cast: happy-dom's `HTMLBodyElement` and prosemirror's `Node` (from
    // `@types/prosemirror-model`'s DOM declarations) aren't structurally
    // identical, but happy-dom's DOM is duck-compatible with the standard
    // DOM at runtime — this is the same path tiptap's upstream
    // `generateJSON` takes (its source has no type annotations so the gap
    // is hidden by `any`). Behaviour is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return PMDOMParser.fromSchema(schema)
      .parse(doc.body as any, options)
      .toJSON();
  } finally {
    // Drop this window from happy-dom's static `browserFrames` Map and
    // release the BrowserWindow + DOM tree. Synchronous for iframe-free
    // content; one microtask later for content with iframes (see header).
    // Either way the Map entry is gone before the next SSR request lands.
    void localWindow.happyDOM.close().catch(() => {
      /* swallow — disposal best-effort */
    });
  }
}
