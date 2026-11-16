import { Prisma } from '@prisma/client';
import {
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
  type RetractedTier,
} from '@civitai/shared/retracted-media-tier';
import { dbRead } from '~/server/db/client';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  tier: RetractedTier;
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. A `suspect` image needs `csamReview`.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean },
  db = dbRead
): Promise<RetractedMedia | null> {
  const [row] = await db.$queryRaw<
    (Omit<RetractedMedia, 'tier'> & { blockedFor: string | null; suspect: boolean })[]
  >`
    SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor",
      ${Prisma.raw(retractedSuspectSql('i'))} AS suspect
    FROM "Image" i
    WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageWhereSql('i'))}
  `;
  if (!row) return null;
  const tier = retractedTier(row, blockedForPatterns());
  if (tier === 'suspect' && !csamReview) return null;
  return { url: row.url, type: row.type, mimeType: row.mimeType, tier };
}
