/**
 * Hidden migration route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Repairs published posts whose images don't all belong to the post owner
 * (Image.userId != Post.userId), the result of an authorization gap on
 * `post.addImage`. Only published posts are processed (Post.publishedAt IS NOT NULL).
 *
 * Per affected post, two cases:
 *   A) ALL images belong to a single non-owner user
 *      → reassign Post.userId to that user (transfer the whole post).
 *   B) Mixed — post owner also has images on the post alongside one or more
 *      non-owner uploaders. For each non-owner uploader, create a new
 *      published post owned by them with the original's createdAt/publishedAt
 *      (and other carry-over fields), then move that uploader's images into
 *      the new post. The original post keeps the post owner's images.
 *
 *      (A "multi-foreign with no owner images" shape is theoretically Case B
 *      too, but it can't arise on published posts — publishing requires the
 *      owner to upload at least one image — so Case A always covers
 *      no-owner-images scenarios in practice.)
 *
 * Discovery: scans the Image table by id range (uses Image PK index) and
 * derives affected postIds per range. A shared `seen` set prevents a post
 * being processed twice when its images span multiple ranges.
 *
 * Query params:
 *   dryRun       boolean (default true)  — log only, no writes
 *   batchSize    int     (default 5000)  — Image.id range per batch
 *   concurrency  int     (default 4)     — parallel batches
 *   start        int     (default min)   — Image.id floor
 *   end          int     (default max)   — Image.id ceiling
 *   since        ISO date (optional)     — only consider corruption events for
 *                                          images created at/after this date
 *
 * Usage:
 *   curl -X POST 'https://<host>/api/admin/temp/fix-cross-posted-images?token=$WEBHOOK_TOKEN&dryRun=true'
 *   curl -X POST 'https://<host>/api/admin/temp/fix-cross-posted-images?token=$WEBHOOK_TOKEN&dryRun=false&since=2026-05-06T03:00:00Z'
 */
import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { userPostCountCache } from '~/server/redis/caches';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

const log = createLogger('fix-cross-posted-images', 'magenta');

const schema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(100000).default(5000),
  concurrency: z.coerce.number().min(1).max(10).default(4),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
  since: z.coerce.date().optional(),
});

type Totals = {
  affectedPosts: number;
  caseAReassigned: number;
  caseBNewPosts: number;
  imagesMoved: number;
  uploadersTouched: Set<number>;
  errors: number;
};

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  const totals: Totals = {
    affectedPosts: 0,
    caseAReassigned: 0,
    caseBNewPosts: 0,
    imagesMoved: 0,
    uploadersTouched: new Set<number>(),
    errors: 0,
  };

  // Shared across batches (single-process, JS event loop). Claim a postId
  // synchronously before any await so two batches can't both pick the same
  // post when its images span multiple Image.id ranges.
  const seen = new Set<number>();

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => {
      const [result] = await (
        await pgDbRead.cancellableQuery<{ start: number; end: number }>(`
          SELECT COALESCE(MIN(id), 0) AS "start", COALESCE(MAX(id), 0) AS "end"
          FROM "Image"
        `)
      ).result();
      return result ?? { start: 0, end: 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      const candidatesQuery = await pgDbRead.cancellableQuery<{ postId: number }>(
        `
        SELECT DISTINCT i."postId" AS "postId"
        FROM "Image" i
        JOIN "Post"  p ON p.id = i."postId"
        WHERE i.id >= $1 AND i.id <= $2
          AND i."userId" <> p."userId"
          AND p."publishedAt" IS NOT NULL
          AND ($3::timestamptz IS NULL OR i."createdAt" >= $3)
      `,
        [start, end, params.since ?? null]
      );
      cancelFns.push(candidatesQuery.cancel);
      const rows = await candidatesQuery.result();
      if (!rows.length) return;

      const newPostIds: number[] = [];
      for (const r of rows) {
        if (seen.has(r.postId)) continue;
        seen.add(r.postId); // claim before awaiting
        newPostIds.push(r.postId);
      }
      if (!newPostIds.length) return;

      totals.affectedPosts += newPostIds.length;
      log(`range ${start}-${end}: ${newPostIds.length} new affected posts`);

      for (const postId of newPostIds) {
        try {
          await processPost(postId, params.dryRun, totals);
        } catch (e) {
          totals.errors += 1;
          log(`post ${postId} failed: ${(e as Error).message}`);
        }
      }
    },
  });

  res.status(200).json({
    finished: true,
    dryRun: params.dryRun,
    affectedPosts: totals.affectedPosts,
    caseAReassigned: totals.caseAReassigned,
    caseBNewPosts: totals.caseBNewPosts,
    imagesMoved: totals.imagesMoved,
    uploadersTouched: totals.uploadersTouched.size,
    errors: totals.errors,
  });
});

async function processPost(postId: number, dryRun: boolean, totals: Totals) {
  const post = await dbRead.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      userId: true,
      title: true,
      detail: true,
      modelVersionId: true,
      availability: true,
      publishedAt: true,
      createdAt: true,
      metadata: true,
      unlisted: true,
      nsfw: true,
      nsfwLevel: true,
    },
  });
  if (!post || !post.publishedAt) return; // safety: published only

  const images = await dbRead.image.findMany({
    where: { postId },
    select: { id: true, userId: true },
    orderBy: { id: 'asc' },
  });
  if (!images.length) return;

  const byUploader = new Map<number, number[]>();
  for (const img of images) {
    const list = byUploader.get(img.userId) ?? [];
    list.push(img.id);
    byUploader.set(img.userId, list);
  }

  const uploaderIds = [...byUploader.keys()];
  const ownerHasImages = byUploader.has(post.userId);
  const foreignUploaders = uploaderIds.filter((u) => u !== post.userId);

  if (foreignUploaders.length === 0) return; // already clean

  // Case A: all images on the post belong to a single non-owner user
  if (uploaderIds.length === 1 && !ownerHasImages) {
    const newOwner = uploaderIds[0];

    log(
      JSON.stringify({
        case: 'A',
        dryRun,
        postId,
        oldOwner: post.userId,
        newOwner,
        imageCount: images.length,
      })
    );

    if (dryRun) return;

    await dbWrite.post.update({
      where: { id: postId },
      data: { userId: newOwner },
    });

    totals.caseAReassigned += 1;
    totals.uploadersTouched.add(newOwner);
    totals.uploadersTouched.add(post.userId);

    try {
      await updatePostNsfwLevel(postId);
      await queueImageSearchIndexUpdate({
        ids: byUploader.get(newOwner) ?? [],
        action: SearchIndexUpdateQueueAction.Update,
      });
      await Promise.all([
        userPostCountCache.refresh(newOwner),
        userPostCountCache.refresh(post.userId),
      ]);
    } catch (e) {
      log(`post ${postId} (case A) post-tx side effects failed: ${(e as Error).message}`);
    }
    return;
  }

  // Case B: mixed — for each foreign uploader, create a new published post and move their images.
  const newPostsCreated: { uploaderId: number; newPostId: number; imageIds: number[] }[] = [];

  for (const uploaderId of foreignUploaders) {
    const imageIds = byUploader.get(uploaderId) ?? [];
    if (!imageIds.length) continue;

    log(
      JSON.stringify({
        case: 'B',
        dryRun,
        originalPostId: postId,
        postOwner: post.userId,
        foreignUploader: uploaderId,
        imageIds,
        imageCount: imageIds.length,
      })
    );

    if (dryRun) continue;

    const newPostId = await dbWrite.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          userId: uploaderId,
          title: post.title,
          detail: post.detail,
          modelVersionId: post.modelVersionId,
          availability: post.availability,
          publishedAt: post.publishedAt,
          createdAt: post.createdAt,
          metadata: post.metadata ?? undefined,
          unlisted: post.unlisted,
          nsfw: post.nsfw,
          nsfwLevel: post.nsfwLevel,
        },
        select: { id: true },
      });

      await tx.$executeRaw`
        UPDATE "Image" AS i
        SET "postId" = ${created.id},
            "index"  = sub.idx
        FROM (
          SELECT id, (row_number() OVER (ORDER BY id) - 1)::int AS idx
          FROM "Image"
          WHERE id IN (${Prisma.join(imageIds)})
        ) AS sub
        WHERE i.id = sub.id
      `;

      return created.id;
    });

    newPostsCreated.push({ uploaderId, newPostId, imageIds });
    totals.caseBNewPosts += 1;
    totals.imagesMoved += imageIds.length;
    totals.uploadersTouched.add(uploaderId);
  }

  if (dryRun || newPostsCreated.length === 0) return;

  totals.uploadersTouched.add(post.userId);

  // Post-tx side effects
  try {
    const allAffectedPostIds = [postId, ...newPostsCreated.map((p) => p.newPostId)];
    const allMovedImageIds = newPostsCreated.flatMap((p) => p.imageIds);
    const allUploaders = [post.userId, ...newPostsCreated.map((p) => p.uploaderId)];

    await updatePostNsfwLevel(allAffectedPostIds);
    await queueImageSearchIndexUpdate({
      ids: allMovedImageIds,
      action: SearchIndexUpdateQueueAction.Update,
    });
    await Promise.all(allUploaders.map((id) => userPostCountCache.refresh(id)));
  } catch (e) {
    log(`post ${postId} (case B) post-tx side effects failed: ${(e as Error).message}`);
  }
}
