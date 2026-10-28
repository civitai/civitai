import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { isViewerContentOwner } from '~/server/services/commentsv2.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';

/**
 * Authors whose comments a viewer must not see on an entity's comments: hidden, blocked-by and
 * blocked users. On the viewer's own content a blocker's engagement stays visible, so the owner can
 * still see and report it. Bounded so it fits a query parameter (`boundExcludedUserIds`).
 */
export async function getCommentExcludedUserIds({
  entityType,
  entityId,
  userId,
}: {
  entityType: CommentConnectorInput['entityType'];
  entityId: number;
  userId?: number;
}) {
  const [hidden, blockedBy, blocked] = await Promise.all([
    HiddenUsers.getCached({ userId }),
    BlockedByUsers.getCached({ userId }),
    BlockedUsers.getCached({ userId }),
  ]);
  const blockedByUsers = blockedBy.map((x) => x.id);
  const isContentOwner = await isViewerContentOwner({
    entityType,
    entityId,
    userId,
    blockedByUsers,
  });
  return boundExcludedUserIds(
    hidden.map((x) => x.id),
    blockedByUsers,
    blocked.map((x) => x.id),
    { isContentOwner }
  );
}
