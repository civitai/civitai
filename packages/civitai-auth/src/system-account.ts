// A system account is driven by API keys only: the hub never opens a session for it, and it never
// receives the onboarding Buzz bonus. The marker lives in `User.meta`.
export const SYSTEM_ACCOUNT_META = { systemAccount: true } as const;

// `User.meta` may be stored as a JSON string; invalid JSON reads as null.
export function parseMeta(meta: unknown): Record<string, unknown> | null {
  let value = meta;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

// Fails closed: any truthy marker counts, including a hand-written `"true"`.
export function isSystemAccountMeta(meta: unknown): boolean {
  return !!parseMeta(meta)?.systemAccount;
}

// Set per account by an admin: lets a system account with moderator access keep using write-scoped
// API keys. Only a literal `true` counts, so a hand-written `"true"` or `1` does not grant it.
export function allowsModeratorWriteKeys(meta: unknown): boolean {
  return parseMeta(meta)?.moderatorWriteKeys === true;
}
