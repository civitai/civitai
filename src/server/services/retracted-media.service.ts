import { Prisma } from '@prisma/client';
import { heldImageKnownSql } from '@civitai/shared/held-media';
import { RETRACTED_MEDIA_READ_TIMEOUT_MS } from '@civitai/shared/retracted-media';
import { moderatorMediaWhereSql, moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
import { OWNER_MEDIA_EXEMPT_BLOCKS } from '~/server/common/image-block-marker';
import { ownerMediaAllowedSql } from '~/server/common/image-visibility';
import { dbWrite } from '~/server/db/client';
import { reviewOfImageSql } from '~/server/services/creator-service-review-image-sql';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  /** Held media (`heldImageSql`), so its serve is recorded as a held view. */
  held: boolean;
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. A moderator without `csamReview` is
 * refused what `moderatorWithheldSql` withholds, the moderator app's rule. Read on the primary: a
 * flag or report the replica has not seen yet would otherwise be missed. A read past its timeout
 * refuses.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview, cdnLeg = false }: { csamReview: boolean; cdnLeg?: boolean },
  db = dbWrite
): Promise<RetractedMedia | null> {
  const [row] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`);
    return tx.$queryRaw<(RetractedMedia & { withheld: boolean })[]>`
      SELECT i.url, i.type::text AS type, i."mimeType",
        ${Prisma.raw(moderatorWithheldSql('i', { csamReview }))} AS withheld,
        ${Prisma.raw(heldImageKnownSql('i'))} AS held
      FROM "Image" i
      WHERE i.id = ${imageId}
        AND ${Prisma.raw(moderatorMediaWhereSql('i', { cdnLeg, csamReview, heldLeg: false }))}
    `;
  });
  if (!row || row.withheld) return null;
  return { url: row.url, type: row.type, mimeType: row.mimeType, held: row.held };
}

export type OwnRetractedMedia = Omit<RetractedMedia, 'held'> & {
  postId: number | null;
  nsfwLevel: number;
};

/**
 * The storage key and type of the viewer's own image while `ownerMediaAllowed` leaves them its media
 * under a reviewed block (`reviewedBlocks`, read again here rather than trusted from the page);
 * `null` otherwise, exactly as a missing image. The row must also pass `image.get`'s visibility
 * conditions for its owner (`imageVisibilityConditions`), so the route opens nothing the image page
 * would not. An owner-level hold does not withhold; the route applies the model hold
 * (`holdLeavesImage`). Read on the primary; past its timeout it refuses.
 */
export async function getOwnRetractedMedia(
  imageId: number,
  userId: number,
  /** `imageVisibilityConditions`' `shownReviewImageLevels`, as the image page passes it. */
  { shownReviewImageLevels }: { shownReviewImageLevels?: number } = {},
  db = dbWrite
): Promise<OwnRetractedMedia | null> {
  const visible = imageVisibilityConditions({
    userId,
    ownerSeesHeld: true,
    shownReviewImageLevels,
    ownerKeepsBlockedRow: true,
  });
  const [row] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`);
    return tx.$queryRaw<OwnRetractedMedia[]>`
      SELECT i.url, i.type::text AS type, i."mimeType", i."postId",
        COALESCE(rw."level", i."nsfwLevel") AS "nsfwLevel"
      FROM "Image" i
      LEFT JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN LATERAL ${reviewOfImageSql} rw ON TRUE
      WHERE i.id = ${imageId}
        AND i."userId" = ${userId}
        AND ${Prisma.join(visible, ' AND ')}
        AND i."blockedFor" IS NOT NULL
        AND i."blockedFor" NOT IN (${Prisma.join(OWNER_MEDIA_EXEMPT_BLOCKS)})
        -- The only clause keeping a CSAM-marked row out, since visible keeps the owner's blocked rows.
        -- Pinned by the test "the owner route on a CSAM-marked row" in retracted-media.service.test.ts.
        AND ${ownerMediaAllowedSql('i', { reviewedBlocks: true })}
    `;
  });
  return row ?? null;
}
