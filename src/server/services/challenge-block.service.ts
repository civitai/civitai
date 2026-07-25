import { Prisma } from '@prisma/client';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';

// The viewer's bounded block/hide exclusion set (hidden ∪ blocked-by ∪ blocked), used to drop
// user challenges whose creator is on it — parity with comment/review feeds. Empty for anon.
// Ordering into boundExcludedUserIds is load-bearing (see its doc): hidden, blockedBy, blocked.
export async function getChallengeExcludedUserIds(viewerId?: number): Promise<number[]> {
  if (!viewerId) return [];
  const [hidden, blockedBy, blocked] = await Promise.all([
    HiddenUsers.getCached({ userId: viewerId }),
    BlockedByUsers.getCached({ userId: viewerId }),
    BlockedUsers.getCached({ userId: viewerId }),
  ]);
  return boundExcludedUserIds(
    hidden.map((u) => u.id),
    blockedBy.map((u) => u.id),
    blocked.map((u) => u.id)
  );
}

// Raw-SQL predicate (aliased `c`) dropping user challenges whose creator is in the viewer's
// exclusion set; System/mod rows always pass via the source guard. Returns null when the set is
// empty so callers can skip pushing it. Shared by the three raw feeds to keep the scoping in sync.
export function challengeCreatorBlockSql(excludedUserIds: number[]): Prisma.Sql | null {
  if (excludedUserIds.length === 0) return null;
  return Prisma.sql`(c.source <> ${ChallengeSource.User}::"ChallengeSource" OR c."createdById" != ALL(${excludedUserIds}::int[]))`;
}
