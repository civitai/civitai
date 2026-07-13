import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import type { MediaType } from '$lib/media/edge-url';

// The comics moderation queue: comic panels whose underlying Image was flagged for review (needsReview),
// hard-flagged as a TOS violation, or stuck in a non-Scanned ingestion state. Ported from the inline
// `comics.getModReviewQueue` query in the main app's comics.router (Prisma → Kysely). A ComicPanel links
// to its chapter by (projectId, chapterPosition) — there is no chapterId column.

export type ComicReviewPanel = {
  id: number;
  position: number;
  chapterPosition: number;
  projectId: number;
  prompt: string | null;
  uploaded: boolean;
  imageId: number;
  imageUrl: string;
  imageType: MediaType;
  nsfwLevel: number;
  needsReview: string | null;
  tosViolation: boolean;
  ingestion: string;
  blockedFor: string | null;
  projectName: string;
  projectStatus: string;
  projectTosViolation: boolean;
  chapterName: string;
  chapterStatus: string;
  authorId: number;
  authorUsername: string | null;
  authorDeletedAt: Date | null;
  authorBannedAt: Date | null;
};

export async function getComicReviewQueue({
  limit,
  cursor,
  needsReview,
  includeTosViolations = true,
}: {
  limit: number;
  cursor?: number;
  needsReview?: string;
  includeTosViolations?: boolean;
}): Promise<{ items: ComicReviewPanel[]; nextCursor?: number }> {
  const rows = await dbRead
    .selectFrom('ComicPanel as p')
    .innerJoin('Image as i', 'i.id', 'p.imageId')
    .innerJoin('ComicProject as proj', 'proj.id', 'p.projectId')
    .innerJoin('ComicChapter as ch', (join) =>
      join.onRef('ch.projectId', '=', 'p.projectId').onRef('ch.position', '=', 'p.chapterPosition')
    )
    .innerJoin('User as u', 'u.id', 'proj.userId')
    .where((eb) => {
      // A panel surfaces if ANY flag is set. A specific reason narrows to just that needsReview value;
      // otherwise "any review reason" unions needsReview + non-Scanned ingestion. TOS violations are
      // unioned in on top (default) so a TOS-swept panel still shows even with needsReview cleared.
      const or = needsReview
        ? [eb('i.needsReview', '=', needsReview)]
        : [eb('i.needsReview', 'is not', null), eb('i.ingestion', '!=', 'Scanned')];
      if (includeTosViolations) or.push(eb('i.tosViolation', '=', true));
      return eb.or(or);
    })
    .$if(cursor != null, (qb) => qb.where('p.id', '<', cursor!))
    .orderBy('p.id', 'desc')
    .select([
      'p.id',
      'p.position',
      'p.chapterPosition',
      'p.projectId',
      // Panels made on-site keep the prompt in one of these; off-site uploads have none. Coalesce so a
      // generated panel always shows its prompt regardless of where it landed.
      sql<string | null>`COALESCE(NULLIF(p.prompt, ''), NULLIF(p."enhancedPrompt", ''), NULLIF(i.meta->>'prompt', ''))`.as(
        'prompt'
      ),
      sql<boolean>`(p.metadata->>'sourceImageUrl') IS NOT NULL`.as('uploaded'),
      'i.id as imageId',
      'i.url as imageUrl',
      'i.type as imageType',
      'i.nsfwLevel',
      'i.needsReview',
      'i.tosViolation',
      'i.ingestion',
      'i.blockedFor',
      'proj.name as projectName',
      'proj.status as projectStatus',
      'proj.tosViolation as projectTosViolation',
      'ch.name as chapterName',
      'ch.status as chapterStatus',
      'u.id as authorId',
      'u.username as authorUsername',
      'u.deletedAt as authorDeletedAt',
      'u.bannedAt as authorBannedAt',
    ])
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (rows.length > limit) nextCursor = rows.pop()?.id;
  return { items: rows as ComicReviewPanel[], nextCursor };
}
