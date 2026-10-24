import { safeReturnPath as sharedSafeReturnPath } from '@civitai/auth/client';

/**
 * A path on THIS app to send someone back to, or null. The validation rule is the shared one in
 * `@civitai/auth`; this app adds only a length cap, since the value comes from an editable query string.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  return sharedSafeReturnPath(raw);
}
