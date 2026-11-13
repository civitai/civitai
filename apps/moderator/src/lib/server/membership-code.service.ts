import { sql } from 'kysely';
import { dbWrite } from '$lib/server/db';
import { SUPPORT_CODE_SOURCE } from '$lib/membership-code';

/**
 * Support codes minted for one account, newest first. Keyed on `userId`, which the mint pre-sets to
 * the customer, so this rides the (userId, createdAt) index; the source filter keeps the customer's
 * shop and gift codes out of a list that offers Revoke.
 */
export async function listSupportMembershipCodes(userId: number) {
  // The primary: the panel refetches this the moment a mint or revoke returns, and a lagging replica
  // would show a revoked code as still open.
  const rows = await dbWrite
    .selectFrom('RedeemableCode')
    .select([
      'code',
      'unitValue',
      'priceId',
      'createdAt',
      'expiresAt',
      'redeemedAt',
      sql<string | null>`metadata ->> 'reason'`.as('reason'),
      sql<string | null>`metadata ->> 'mintedBy'`.as('mintedBy'),
      sql<string | null>`metadata ->> 'revokedAt'`.as('revokedAt'),
    ])
    .where('userId', '=', userId)
    .where(sql<string>`metadata ->> 'source'`, '=', SUPPORT_CODE_SOURCE)
    .orderBy('createdAt', 'desc')
    .limit(25)
    .execute();

  return rows.map((r) => ({
    code: r.code,
    months: r.unitValue,
    tier: r.priceId?.replace(/-monthly$/, '') ?? null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    redeemedAt: r.redeemedAt,
    revokedAt: r.revokedAt,
    reason: r.reason,
    mintedBy: r.mintedBy === null ? null : Number(r.mintedBy),
  }));
}

export type SupportMembershipCodeRow = Awaited<
  ReturnType<typeof listSupportMembershipCodes>
>[number];
