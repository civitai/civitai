import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { getBasicDataForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { isImageOwner } from '~/server/services/util.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

// Dislike is retired from the UI, same exclusion as Creator Studio's "Who reacted".
export const IMAGE_REACTOR_TYPES = ['Like', 'Heart', 'Laugh', 'Cry'] as const;
export const IMAGE_REACTORS_LIMIT = 10;

type ReactorRow = { userId: number; reaction: ReviewReactions };

/**
 * Groups rows (already in newest-account order) into at most `limit` distinct users. A user has at most one row
 * per reaction type, so fetching `limit * IMAGE_REACTOR_TYPES.length` rows always completes the last user kept.
 */
export function groupReactorRows(rows: ReactorRow[], limit = IMAGE_REACTORS_LIMIT) {
  const byUser = new Map<number, ReviewReactions[]>();
  for (const { userId, reaction } of rows) {
    const reactions = byUser.get(userId);
    if (reactions) reactions.push(reaction);
    else if (byUser.size < limit) byUser.set(userId, [reaction]);
  }
  return [...byUser].map(([userId, reactions]) => ({ userId, reactions }));
}

// Same rule as Creator Studio's "Who reacted": only a scanned, safe-level picture leaves the server.
export function safeProfilePicture(picture: ProfileImage | null | undefined) {
  if (!picture || picture.ingestion !== 'Scanned' || picture.nsfwLevel <= 0) return null;
  return (picture.nsfwLevel & ~sfwBrowsingLevelsFlag) === 0 ? picture : null;
}

/**
 * The newest accounts that reacted to one of the caller's images. Not reaction-time order: only the
 * `(imageId, userId) INCLUDE (reaction)` index serves this at constant cost; no index covers `createdAt` with
 * `userId`, so ordering by it reads every reaction on the image.
 */
export async function getImageReactors({ imageId, userId }: { imageId: number; userId: number }) {
  if (!(await isImageOwner({ userId, imageId, allowMods: false })))
    throw throwNotFoundError(`No image with id ${imageId}`);

  const rows = await dbRead.$queryRaw<ReactorRow[]>`
    SELECT "userId", reaction FROM "ImageReaction"
    WHERE "imageId" = ${imageId}
      AND reaction::text IN (${Prisma.join([...IMAGE_REACTOR_TYPES])})
    ORDER BY "userId" DESC
    LIMIT ${IMAGE_REACTORS_LIMIT * IMAGE_REACTOR_TYPES.length}
  `;
  const grouped = groupReactorRows(rows);
  if (!grouped.length) return [];

  const ids = grouped.map((r) => r.userId);
  const [users, profilePictures] = await Promise.all([
    getBasicDataForUsers(ids),
    getProfilePicturesForUsers(ids),
  ]);

  return grouped.map(({ userId, reactions }) => {
    const user = users[userId];
    const deleted = !user || !!user.deletedAt;
    return {
      userId,
      reactions,
      username: deleted ? null : user.username,
      deletedAt: user?.deletedAt ?? null,
      profilePicture: deleted ? null : safeProfilePicture(profilePictures[userId]),
    };
  });
}
