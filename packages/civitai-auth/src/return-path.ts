// Same-origin return-path validation, shared by every app so the rule lives in one place. Pure and
// browser-safe (no node built-ins): re-exported from both the main entry and `@civitai/auth/client`.

const PROBE_ORIGIN = 'https://return-path.invalid';

/**
 * A path on the current origin to send someone back to, or null. The input usually arrives in a query
 * string anyone can edit, so anything that could leave the origin is refused rather than repaired: a
 * scheme (`https:`, `javascript:`), a protocol-relative `//host`, and backslashes or control characters
 * anywhere, which browsers rewrite before navigating (`\` becomes `/`, and tab/LF/CR are removed).
 *
 * Returns the NORMALISED form (`pathname + search + hash` as a browser would resolve it), which is what
 * was checked, so callers navigate to exactly the value that passed.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  // Checked again on the OUTPUT, because the output is what gets used: dot segments normalise
  // `/.//x` and `/a/..//x` to `//x`, which passed every check on the raw input above.
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('//')) return null;
  return url.pathname + url.search + url.hash;
}
