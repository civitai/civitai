import { dbRead } from '~/server/db/client';
import { UserEngagementType } from '~/shared/utils/prisma/enums';

type EngagementRow = { userId: number; targetUserId: number; type: UserEngagementType };

// A block in either direction wins: the viewer's own Block row sits beside the other user's
// Follow row, since each direction is its own primary-key row.
export function followsViewerFromRows(
  rows: EngagementRow[],
  { viewerId, userId }: { viewerId: number; userId: number }
) {
  if (rows.some((row) => row.type === UserEngagementType.Block)) return false;
  return rows.some(
    (row) =>
      row.userId === userId &&
      row.targetUserId === viewerId &&
      row.type === UserEngagementType.Follow
  );
}

export async function getFollowsViewer({ viewerId, userId }: { viewerId: number; userId: number }) {
  if (viewerId === userId) return false;
  const rows = await dbRead.$queryRaw<EngagementRow[]>`
    SELECT "userId", "targetUserId", "type"
    FROM "UserEngagement"
    WHERE ("userId" = ${userId} AND "targetUserId" = ${viewerId})
       OR ("userId" = ${viewerId} AND "targetUserId" = ${userId})
  `;
  return followsViewerFromRows(rows, { viewerId, userId });
}
