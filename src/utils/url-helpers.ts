/**
 * Collapses anything that isn't a same-origin path to `fallback`, so a caller-supplied
 * `returnUrl` can't be turned into an off-site redirect.
 *
 * Same rule as `safePath` in `@civitai/auth`, restated here rather than imported: that module
 * pulls node `crypto` at import time, and this one runs in the browser.
 */
export function safeInternalPath(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.startsWith('/') && !/^\/[/\\]/.test(raw) ? raw : fallback;
}
