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
 * and call `await window.happyDOM.close()` in a `finally` block.
 * `happyDOM.close()` triggers the destroy chain in `BrowserWindow` which
 * calls `WindowBrowserContext.removeWindowBrowserFrameRelation(this)` and
 * frees the entry from the static `browserFrames` Map. This matches
 * happy-dom's documented disposal contract.
 *
 * The callers in this codebase only need the synchronous result of
 * `parseFromString(...).toJSON()`, so the close can run without awaiting
 * — it will resolve in the background and is safe to fire-and-forget for
 * teardown. We `void` it to keep the function signature synchronous and
 * avoid changing every callsite to `await`.
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
    // release the BrowserWindow + DOM tree. The returned promise resolves
    // when async tasks (none for our parse-only flow) complete; we don't
    // need to await it for correctness, but we don't want an unhandled
    // rejection in the unlikely event close() throws.
    void localWindow.happyDOM.close().catch(() => {
      /* swallow — disposal best-effort */
    });
  }
}
