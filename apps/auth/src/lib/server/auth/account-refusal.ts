import { error } from '@sveltejs/kit';
import { isMemorializedFlags } from '@civitai/shared/memorial';
import { logToAxiom } from '../axiom';
import { isRefusedModerationAccount } from './moderation-account';

export type AccountRefusal = 'moderation-account' | 'memorialized';

export const MEMORIALIZED_SIGN_IN_REFUSED =
  'This account has been memorialized and can no longer be signed in to.';

/** A token mint refused because the account is memorialized. The OAuth grants answer it as invalid_grant. */
export class MemorializedAccountError extends Error {
  constructor() {
    super(MEMORIALIZED_SIGN_IN_REFUSED);
    this.name = 'MemorializedAccountError';
  }
}

/**
 * Why `userId` may not be given a new session or token, or null. Read from the user's row on every call,
 * never from the caller's user object or the session cache, so a memorialization or its reversal counts at
 * once. `impersonation`: the session being minted is a moderator's impersonation, which a memorialized
 * account still allows. An unknown user is not refused here. Throws when the read fails.
 */
export async function refusedAccountReason(
  userId: number,
  source: string,
  { impersonation = false }: { impersonation?: boolean } = {}
): Promise<AccountRefusal | null> {
  // Lazy: the db module builds its pool at import and throws without DATABASE_URL, and session.ts is
  // imported by code and tests that never reach a mint.
  const { db } = await import('../db/db');
  const row = await db
    .selectFrom('User')
    .select(['id', 'username', 'flags'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (isRefusedModerationAccount(row ?? { id: userId }, source)) return 'moderation-account';
  if (!row || impersonation || !isMemorializedFlags(row.flags)) return null;
  logToAxiom({
    name: 'memorialized-account-refused',
    type: 'info',
    source: `auth-hub:${source}`,
    userId,
  });
  return 'memorialized';
}

/** 403 with the sign-in message when `userId` may not hold a session. */
export async function refuseAccountSession(
  userId: number,
  source: string,
  opts?: { impersonation?: boolean }
): Promise<void> {
  const reason = await refusedAccountReason(userId, source, opts);
  if (reason === 'moderation-account') error(403, 'This account cannot sign in.');
  if (reason === 'memorialized') error(403, MEMORIALIZED_SIGN_IN_REFUSED);
}

/** For a token mint: the moderation account as a 403, a memorialized account as {@link MemorializedAccountError}. */
export async function refuseAccountToken(userId: number, source: string): Promise<void> {
  const reason = await refusedAccountReason(userId, source);
  if (reason === 'moderation-account') error(403, 'This account cannot sign in.');
  if (reason === 'memorialized') throw new MemorializedAccountError();
}
