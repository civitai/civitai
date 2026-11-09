import { Prisma } from '@prisma/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import { getCreatorGalleryHiddenUserIds } from '~/server/services/creator-gallery-hidden-users.service';
import { createNotification } from '~/server/services/notification.service';

type PinnedPosts = Record<string, number[]> | undefined;

export const modelGalleryPostPinnedKey = (modelVersionId: number, postId: number) =>
  `model-gallery-post-pinned:${modelVersionId}:${postId}`;

export function newlyPinnedPosts(prev: PinnedPosts, next: PinnedPosts) {
  const added: { modelVersionId: number; postId: number }[] = [];
  for (const [versionKey, postIds] of Object.entries(next ?? {})) {
    const modelVersionId = Number(versionKey);
    if (!Number.isInteger(modelVersionId)) continue;
    const before = new Set(prev?.[versionKey] ?? []);
    for (const postId of new Set(postIds)) {
      if (!before.has(postId)) added.push({ modelVersionId, postId });
    }
  }
  return added;
}

/**
 * Tells a post's author that the model's owner pinned it to a version gallery. The key is permanent
 * per version and post: the notifications worker never re-delivers a key a user already has, so an
 * unpin and re-pin stays silent.
 */
export async function notifyNewlyPinnedPosts({
  model,
  owner,
  prev,
  next,
}: {
  model: { id: number; name: string };
  owner: { id: number; username: string | null | undefined };
  prev: PinnedPosts;
  next: {
    pinnedPosts: PinnedPosts;
    hiddenUserIds: number[];
    hiddenImages: Record<string, number[]> | undefined;
  };
}) {
  const added = newlyPinnedPosts(prev, next.pinnedPosts);
  if (!added.length) return 0;

  const creatorHiddenUserIds = await getCreatorGalleryHiddenUserIds(owner.id);
  const hiddenUserIds = [...new Set([...next.hiddenUserIds, ...creatorHiddenUserIds])];

  let sent = 0;
  for (const { modelVersionId, postId } of added) {
    const hiddenImageIds = next.hiddenImages?.[modelVersionId] ?? [];
    // A post the owner hid from this gallery, or by an author they hid, was not pinned as credit.
    const [post] = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT p."userId"
      FROM "Post" p
      WHERE p.id = ${postId}
        AND p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= now()
        AND p."userId" <> ${owner.id}
        AND NOT (p."userId" = ANY(${hiddenUserIds}::int[]))
        AND EXISTS (
          SELECT 1 FROM "Image" i
          WHERE i."postId" = p.id AND NOT (i.id = ANY(${hiddenImageIds}::int[]))
        )
        AND ${Prisma.raw(notBlockedBetween('p."userId"', String(Number(owner.id))))}
    `;
    if (!post) continue;

    await createNotification({
      userId: post.userId,
      type: 'model-gallery-post-pinned',
      category: NotificationCategory.Update,
      key: modelGalleryPostPinnedKey(modelVersionId, postId),
      details: {
        modelId: model.id,
        modelName: model.name,
        modelVersionId,
        postId,
        username: owner.username,
      },
    });
    sent++;
  }
  return sent;
}
