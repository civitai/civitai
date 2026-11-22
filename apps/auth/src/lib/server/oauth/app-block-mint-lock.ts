import { sql, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** How long a mint waits on a suspension's row lock before it fails (and mints nothing). */
const APP_BLOCK_LOCK_TIMEOUT_MS = 5_000;

/**
 * The one suspension rule, the main app's revoke rule (`revokeAppBlockOauthTokens`): a client is suspended
 * when one of its blocks is suspended and none is approved, so a client keeps its tokens while any of its
 * blocks is approved.
 */
function suspendedWithoutApproved(blocks: { status: string }[]): boolean {
  return (
    blocks.some((b) => b.status === 'suspended') && !blocks.some((b) => b.status === 'approved')
  );
}

/**
 * Whether the client backs a suspended app block and no approved one, read FOR SHARE so the rows stay
 * locked until `trx` ends.
 *
 * The main app suspends a block and deletes its client's tokens in one transaction, which holds the
 * block row's lock until it commits. This read waits on that lock, so a token inserted in `trx` either
 * sees the suspension and is refused, or commits first and is there for the delete.
 */
export async function lockAppBlockSuspended(trx: Transaction<DB>, clientId: string) {
  await sql`SET LOCAL lock_timeout = ${sql.lit(`${APP_BLOCK_LOCK_TIMEOUT_MS}ms`)}`.execute(trx);
  const blocks = await trx
    .selectFrom('app_blocks')
    .select('status')
    .where('app_id', '=', clientId)
    .orderBy('id')
    .forShare()
    .execute();
  return suspendedWithoutApproved(blocks);
}
