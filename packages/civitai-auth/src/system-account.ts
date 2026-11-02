// A system account is driven by API keys only: the hub never opens a session for it, and it never
// receives the onboarding Buzz bonus. The marker lives in `User.meta`.
export const SYSTEM_ACCOUNT_META = { systemAccount: true } as const;

// Fails closed: any truthy marker counts, including a hand-written `"true"`, and so does `meta`
// stored as a JSON string rather than an object.
export function isSystemAccountMeta(meta: unknown): boolean {
  let value = meta;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    !!(value as { systemAccount?: unknown }).systemAccount
  );
}
