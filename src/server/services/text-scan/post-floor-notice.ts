import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import {
  logRatingNoticeDecision,
  notifyTextScanRatingRaised,
  ratingRose,
  type RatingNoticeDecision,
} from '~/server/services/text-scan/notify';

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
  const decide = (
    id: number,
    decision: RatingNoticeDecision,
    workflowId: string | null = null,
    baseline: number | null = null
  ) =>
    logRatingNoticeDecision({
      path: 'job',
      entityType: 'Post',
      entityId: id,
      workflowId,
      decision,
      before: 0,
      baseline,
      after: firstRated.get(id)?.after ?? null,
    });
  const found = new Set(candidates.map((c) => c.id));
  for (const id of firstRated.keys()) if (!found.has(id)) decide(id, 'no-nsfw-verdict');

  for (const post of candidates) {
    const labels = post.triggeredLabels;
    const images = post.images ?? 0;
    const { userId, workflowId } = post;
    const skip = (decision: RatingNoticeDecision) => decide(post.id, decision, workflowId, images);
    if (labels.includes('poi') || labels.includes('minor')) {
      skip('deferred-poi-minor');
      continue;
    }
    if (post.moderatorNsfwLevel != null) {
      skip('moderator-rated');
      continue;
    }
    if (!userId) {
      skip('no-owner');
      continue;
    }
    if (!workflowId) {
      skip('no-workflow');
      continue;
    }
    const change = firstRated.get(post.id);
    // change.before is 0 here; compare against the images alone, as raiseToFloor does.
    if (!change || !ratingRose(images, change.after)) {
      decide(post.id, 'no-rise', workflowId, images);
      continue;
    }
    // One failed notice must not drop the rest of the batch.
    try {
      await notifyTextScanRatingRaised({
        entityType: 'Post',
        entityId: post.id,
        userId,
        level: highestNsfwLevel(change.after),
        title: post.title,
        url: `/posts/${post.id}`,
        workflowId,
      });
      decide(post.id, 'sent', workflowId, images);
    } catch (error) {
      decide(post.id, 'notice-failed', workflowId, images);
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
