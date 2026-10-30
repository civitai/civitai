import { dbWrite } from '$lib/server/db';

/**
 * Creator Score grants on one account, newest first, revoked ones included so the list is the audit
 * trail.
 */
export async function listCreatorScoreGrants(userId: number) {
  // The primary: the panel refetches this the moment a grant or revoke returns, and a lagging replica
  // would show a revoked grant as still active.
  return dbWrite
    .selectFrom('CreatorScoreGrant as g')
    .leftJoin('User as granter', 'granter.id', 'g.grantedById')
    .leftJoin('User as revoker', 'revoker.id', 'g.revokedById')
    .select([
      'g.id',
      'g.amount',
      'g.reason',
      'g.createdAt',
      'g.revokedAt',
      'g.revokeReason',
      'granter.username as grantedBy',
      'revoker.username as revokedBy',
    ])
    .where('g.userId', '=', userId)
    .orderBy('g.createdAt', 'desc')
    .limit(50)
    .execute();
}

export type CreatorScoreGrantRow = Awaited<ReturnType<typeof listCreatorScoreGrants>>[number];
