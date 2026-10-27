// A system account is driven by API keys only: the hub never opens a session for it, and it never
// receives the onboarding Buzz bonus. The marker lives in `User.meta`.
export const SYSTEM_ACCOUNT_META = { systemAccount: true } as const;

export function isSystemAccountMeta(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { systemAccount?: unknown }).systemAccount === true
  );
}
