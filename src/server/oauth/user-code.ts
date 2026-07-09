/**
 * Device-flow `user_code` format — the single source of truth shared by the
 * server generator (`pages/api/auth/oauth/device.ts`) and the client entry page
 * (`pages/login/oauth/device.tsx`).
 *
 * A user code is `USER_CODE_LENGTH` chars from `USER_CODE_CHARSET`, displayed
 * grouped as `XXXX-XXXX` (a single hyphen at `USER_CODE_GROUP_SIZE`). The
 * charset omits I/O/0/1 to avoid look-alike confusion when reading off a device.
 *
 * This file is import-safe on the client (no node-only deps) so the page can
 * derive completeness/format from the same constants instead of hardcoding `8`.
 */

// No I/O/0/1 to avoid confusion.
export const USER_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const USER_CODE_LENGTH = 8;
export const USER_CODE_GROUP_SIZE = 4;

/**
 * Strip the grouping hyphen / whitespace and uppercase — the canonical form for
 * length/completeness checks. (The Redis lookup key is the *formatted* value;
 * use `formatUserCode` for that. This is only for measuring completeness.)
 */
export function normalizeUserCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Re-insert the grouping hyphen to produce the canonical lookup form
 * (`XXXX-XXXX`). Accepts either a raw or already-formatted value. Only inserts
 * the hyphen once the input has filled past the first group, so partial input
 * isn't prematurely hyphenated.
 */
export function formatUserCode(input: string): string {
  const normalized = normalizeUserCode(input);
  if (normalized.length <= USER_CODE_GROUP_SIZE) return normalized;
  return `${normalized.slice(0, USER_CODE_GROUP_SIZE)}-${normalized.slice(USER_CODE_GROUP_SIZE)}`;
}

/** True when the normalized input is exactly a full-length user code. */
export function isUserCodeComplete(input: string): boolean {
  return normalizeUserCode(input).length === USER_CODE_LENGTH;
}
