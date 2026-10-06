const PROBE_ORIGIN = 'https://return-path.invalid';

/**
 * A path on THIS app to send someone back to, or null. The input arrives in a query string anyone can
 * edit, so anything that could leave the app is refused rather than repaired: a scheme
 * (`https:`, `javascript:`), a protocol-relative `//host`, and backslashes or control characters,
 * which browsers rewrite (`/\host` and `/<tab>/host` both become `//host`).
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  // The checks above should make this unreachable; it is the one that does not depend on knowing
  // every way a browser normalises a URL.
  if (url.origin !== PROBE_ORIGIN) return null;
  return url.pathname + url.search + url.hash;
}
