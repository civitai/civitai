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

// The text-scan callback sees no rise on a post whose images are unrated, so the floor lands on this
// recompute. Only that first rating is the callback's to report: a rated post's later changes are
// the images'. Notify under the callback's workflowId so the two paths dedupe.
export async function notifyPostFloorRaises(
  changes: { id: number; before: number; after: number }[]
) {
  const firstRated = new Map(
    changes.filter((c) => c.before === 0 && c.after !== 0).map((c) => [c.id, c] as const)
  );
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
    // Judged as the callback would judge the verdict landing on the rated images.
    if (!change || !ratingRose(post.images ?? 0, change.after)) continue;
    await notifyTextScanRatingRaised({
      entityType: 'Post',
      entityId: post.id,
      userId: post.userId,
      level: highestNsfwLevel(change.after),
      title: post.title,
      url: `/posts/${post.id}`,
      workflowId: post.workflowId,
    });
  }
}
