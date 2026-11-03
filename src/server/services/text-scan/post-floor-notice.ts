import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
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

// An unrated post (images at 0) stays 0 whatever the floor, so the callback sees no rise and sends
// nothing. The floor lands here, on the level recompute; notify under the callback's workflowId key.
export async function notifyPostFloorRaises(
  changes: { id: number; before: number; after: number }[]
) {
  const risen = new Map(
    changes.filter((c) => ratingRose(c.before, c.after)).map((c) => [c.id, c] as const)
  );
  if (!risen.size) return;

  const candidates = await dbWrite.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT p.id, p."userId", p.title, p."moderatorNsfwLevel", em."workflowId", em."triggeredLabels",
      (SELECT bit_or(i."nsfwLevel") FROM "Image" i WHERE i."postId" = p.id) AS images
    FROM "Post" p
    JOIN "EntityModeration" em ON em."entityType" = 'Post' AND em."entityId" = p.id
    WHERE p.id IN (${Prisma.join([...risen.keys()])})
      AND 'nsfw' = ANY(em."triggeredLabels")
  `);
  for (const post of candidates) {
    const labels = post.triggeredLabels;
    if (labels.includes('poi') || labels.includes('minor')) continue;
    if (post.moderatorNsfwLevel != null || !post.userId || !post.workflowId) continue;
    const level = highestNsfwLevel(risen.get(post.id)?.after);
    // Images that reach the level on their own raised the post, not the text.
    if (highestNsfwLevel(post.images) >= level) continue;
    await notifyTextScanRatingRaised({
      entityType: 'Post',
      entityId: post.id,
      userId: post.userId,
      level,
      title: post.title,
      url: `/posts/${post.id}`,
      workflowId: post.workflowId,
    });
  }
}
