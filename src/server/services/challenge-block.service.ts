import { Prisma } from '@prisma/client';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { getHiddenOrBlockedUserIds } from '~/server/services/user-preferences.service';

// The viewer's bounded block/hide exclusion set, used to drop user challenges whose creator is on
// it — parity with comment/review feeds. Empty for anon.
export async function getChallengeExcludedUserIds(viewerId?: number): Promise<number[]> {
  return viewerId ? getHiddenOrBlockedUserIds(viewerId) : [];
}

// Raw-SQL predicate (aliased `c`) dropping user challenges whose creator is in the viewer's
// exclusion set; System/mod rows always pass via the source guard. Returns null when the set is
// empty so callers can skip pushing it. Shared by the three raw feeds to keep the scoping in sync.
export function challengeCreatorBlockSql(excludedUserIds: number[]): Prisma.Sql | null {
  if (excludedUserIds.length === 0) return null;
  return Prisma.sql`(c.source <> ${ChallengeSource.User}::"ChallengeSource" OR c."createdById" != ALL(${excludedUserIds}::int[]))`;
}
