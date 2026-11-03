import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import { notifyTextScanRatingRaised, ratingRose } from '~/server/services/text-scan/notify';

type Candidate = {
  id: number;
  userId: number | null;
  title: string | null;
  moderatorNsfwLevel: number | null;
  workflowId: string | null;
  triggeredLabels: string[];
  images: number | null;
};

const isFirstRating = (c: { before: number; after: number }) => c.before === 0 && c.after !== 0;

// Notify under the callback's workflowId, or this and the callback path send the owner two notices.
export async function notifyPostFloorRaises(
  changes: { id: number; before: number; after: number }[]
) {
  const firstRated = new Map(changes.filter(isFirstRating).map((c) => [c.id, c] as const));
  if (!firstRated.size) return;

  const candidates = await dbWrite.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT p.id, p."userId", p.title, p."moderatorNsfwLevel", em."workflowId", em."triggeredLabels",
      (SELECT bit_or(i."nsfwLevel") FROM "Image" i WHERE i."postId" = p.id) AS images
    FROM "Post" p
    JOIN "EntityModeration" em ON em."entityType" = 'Post' AND em."entityId" = p.id
    WHERE p.id IN (${Prisma.join([...firstRated.keys()])})
      AND 'nsfw' = ANY(em."triggeredLabels")
  `);
  for (const post of candidates) {
    const labels = post.triggeredLabels;
    if (labels.includes('poi') || labels.includes('minor')) continue;
    if (post.moderatorNsfwLevel != null || !post.userId || !post.workflowId) continue;
    const change = firstRated.get(post.id);
    // change.before is 0 here; compare against the images alone, as raiseToFloor does.
    if (!change || !ratingRose(post.images ?? 0, change.after)) continue;
    // One failed notice must not drop the rest of the batch.
    try {
      await notifyTextScanRatingRaised({
        entityType: 'Post',
        entityId: post.id,
        userId: post.userId,
        level: highestNsfwLevel(change.after),
        title: post.title,
        url: `/posts/${post.id}`,
        workflowId: post.workflowId,
      });
    } catch (error) {
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'post floor notice failed',
        postId: post.id,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: (error as { code?: unknown } | null | undefined)?.code,
      }).catch(() => undefined);
    }
  }
}
