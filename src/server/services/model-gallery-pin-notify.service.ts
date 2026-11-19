import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
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
 * Tells a post's author that the model's owner pinned it to a version gallery. The key is per
 * version and post, and the notifications worker does not re-deliver a key a user still has, so an
 * unpin and re-pin stays silent until retention cleanup prunes the first one.
 *
 * `pinnedPosts` is client-supplied with free-form version keys, so a pin only counts when the version
 * is one of this published model's and the post shows in that version's gallery; otherwise any owner
 * could message any author once per invented version id. The eligibility rule tracks the gallery
 * read path (image.controller pinned posts, `filterPinnedImagesToVersion`), but is stricter: a post
 * with no resource link to the version is not notified. A visibility change there belongs here too.
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
  const added = newlyPinnedPosts(prev, next.pinnedPosts).slice(
    0,
    constants.modelGallery.maxPinnedPosts
  );
  if (!added.length) return 0;

  const creatorHiddenUserIds = await getCreatorGalleryHiddenUserIds(owner.id);
  const hiddenUserIds = [...new Set([...next.hiddenUserIds, ...creatorHiddenUserIds])];

  let sent = 0;
  for (const { modelVersionId, postId } of added) {
    const hiddenImageIds = next.hiddenImages?.[modelVersionId] ?? [];
    // Primary: ImageResourceNew can lag on the replica, and this runs once per owner save.
    const [post] = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT p."userId"
      FROM "Post" p
      JOIN "ModelVersion" mv ON mv.id = ${modelVersionId} AND mv."modelId" = ${model.id}
      JOIN "Model" m ON m.id = mv."modelId" AND m.status = 'Published'
      WHERE p.id = ${postId}
        AND p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= now()
        AND NOT p."tosViolation"
        AND p.availability <> 'Private'
        AND p."userId" <> ${owner.id}
        AND NOT (p."userId" = ANY(${hiddenUserIds}::int[]))
        AND EXISTS (
          SELECT 1 FROM "Image" i
          WHERE i."postId" = p.id
            AND NOT (i.id = ANY(${hiddenImageIds}::int[]))
            AND NOT i."tosViolation"
            AND i."needsReview" IS NULL
            AND (
              p."modelVersionId" = mv.id
              OR EXISTS (
                SELECT 1 FROM "ImageResourceNew" ir
                WHERE ir."imageId" = i.id AND ir."modelVersionId" = mv.id
              )
            )
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
