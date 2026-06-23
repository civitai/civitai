/**
 * Pure decision helper for the `image-scanner-new` sysRedis kill-switch.
 *
 * Lives in its own tiny module so the Buffer-coercion + seed-only-on-unset
 * behavior is unit-testable without importing the ~7.9K-line image.service
 * (which drags in Prisma/env/auth at load time and can't load under vitest).
 *
 * sysRedis.get is typed `string` but the HA/Sentinel client returns a Buffer
 * for BLOB_STRING replies, matching none of the four literals → pre-fix
 * `isImageScannerNewEnabled` fell through and DESTRUCTIVELY overwrote the
 * operator's '1' with 'false' (then returned false). Coerce once before
 * comparing. See PR #2697/#2700 for the canonical Buffer-vs-string regression.
 *
 * Returns:
 *   - `true`  for '1' / 'true'
 *   - `false` for '0' / 'false'
 *   - `null`  for a genuinely-unset/unknown key — the ONLY case in which the
 *             caller should default-seed 'false'.
 */
export function parseScannerFlag(raw: unknown): boolean | null {
  const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}
