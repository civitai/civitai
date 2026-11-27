import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { createScanImage, readObject } from '~/server/services/creator-service-deal-file.service';
import { finalCsamHeldSql } from '~/server/services/creator-service-deal-file-held-sql';
import { liveFile } from '~/server/services/creator-service-deal-file-sql';
import { dealFinalsClear } from '~/server/services/creator-service-escrow.service';
import { buildEntryScanCopy } from '~/server/utils/service-deal-preview';
import { getBucket, uploadImageBufferToStore } from '~/utils/s3-utils';
import {
  SERVICE_DEAL_REVIEW_IMAGE_MAX,
  SERVICE_PREVIEW_MIME_TYPES,
} from '~/shared/constants/creator-services.constants';
import {
  reviewImageLevelSql,
  reviewImageVisibleSql,
} from '~/server/services/creator-service-review-image-sql';

/** Still images only: a review's video waits on the streamed video scan copy. */
const IMAGE_MIMES = Prisma.join(
  SERVICE_PREVIEW_MIME_TYPES.filter((mime) => mime.startsWith('image/'))
);
/** The largest final read into memory to make its copy. */
const SOURCE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The finals a buyer may attach to their review, with `r` the review, `d` its deal and `f` the
 * file: a still image of the current round that passed its scans, is still kept and is not held
 * (`finalCsamHeldSql`), on a deal that was never disputed and whose finals all cleared, of a service
 * whose seller allows review work.
 */
const attachable = (userId: number) => Prisma.sql`(
  r."buyerId" = ${userId}::int AND r."hiddenAt" IS NULL
  AND d."id" = r."dealId" AND d."reviewEnabledAt" IS NOT NULL AND d."disputeOpenedAt" IS NULL
  AND ${dealFinalsClear(Prisma.sql`d`)}
  AND EXISTS (SELECT 1 FROM "ServiceOffering" o WHERE o."id" = d."offeringId" AND o."allowReviewWork")
  AND f."dealId" = d."id" AND f."kind" = 'Final'::"ServiceDealFileKind"
  AND f."round" = d."revisionsUsed" AND ${liveFile(Prisma.sql`f`)}
  AND f."status" = 'Ready'::"ServiceDealFileStatus" AND f."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
  AND f."mimeType" IN (${IMAGE_MIMES}) AND f."size" <= ${SOURCE_MAX_BYTES}
  AND NOT ${finalCsamHeldSql(Prisma.sql`f."id"`)}
  AND NOT EXISTS (SELECT 1 FROM "ServiceDealReviewImage" ri
    WHERE ri."reviewId" = r."id" AND ri."sourceFileId" = f."id")
)`;

const attachedCount = Prisma.sql`(SELECT count(*) FROM "ServiceDealReviewImage" ri WHERE ri."reviewId" = r."id")`;

/** What the buyer's picker offers for their review of `dealId`; empty once the cap is reached. */
export async function listReviewAttachableFinals({
  dealId,
  userId,
}: {
  dealId: number;
  userId: number;
}) {
  return dbWrite.$queryRaw<{ id: number; fileName: string | null; mimeType: string }[]>`
    SELECT f."id", f."fileName", f."mimeType"
    FROM "ServiceDealReview" r, "ServiceDeal" d, "ServiceDealFile" f
    WHERE r."dealId" = ${dealId}::int AND ${attachable(userId)}
      AND ${attachedCount} < ${SERVICE_DEAL_REVIEW_IMAGE_MAX}
    ORDER BY f."id"`;
}

/**
 * Attaches one of the deal's finals to the buyer's review as a fresh image: a downscaled copy,
 * owned by the buyer and scanned like any upload. The image is shown only once it passes its scan
 * at or below the deal's level (see `reviewImageVisibleSql`). Eligibility is checked before the copy is
 * made and again, with the cap, as the row is written; a copy that loses that race is deleted.
 */
export async function attachFinalToReview({
  dealId,
  userId,
  fileId,
  reviewFlag,
}: {
  dealId: number;
  userId: number;
  fileId: number;
  reviewFlag: boolean;
}) {
  if (!reviewFlag)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reviews are not available.' });
  const notAttachable = () =>
    new TRPCError({ code: 'CONFLICT', message: 'That file cannot be added to this review.' });
  // One attach per review at a time, so a burst never makes a copy per request.
  const attached = await withDistributedLock(
    { key: `creator-service-deal-review-attach:${dealId}`, autoRenew: true, maxRetries: 0 },
    async () => {
      const [source] = await dbWrite.$queryRaw<{ s3Key: string }[]>`
        SELECT f."s3Key" FROM "ServiceDealReview" r, "ServiceDeal" d, "ServiceDealFile" f
        WHERE r."dealId" = ${dealId}::int AND f."id" = ${fileId}::int AND ${attachable(userId)}
          AND ${attachedCount} < ${SERVICE_DEAL_REVIEW_IMAGE_MAX}`;
      if (!source) throw notAttachable();

      const copy = await buildEntryScanCopy(await readObject(await getBucket(), source.s3Key));
      const { key } = await uploadImageBufferToStore(copy.data, { contentType: copy.mimeType });
      const image = await createScanImage(key, copy, userId);

      const linked = await dbWrite.$transaction(async (tx) => {
        // The review row serialises the cap across concurrent attaches.
        await tx.$queryRaw`SELECT 1 FROM "ServiceDealReview" WHERE "dealId" = ${dealId}::int FOR UPDATE`;
        return tx.$executeRaw`
          INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId", "sourceFileId")
          SELECT r."id", ${image.id}::int, f."id"
          FROM "ServiceDealReview" r, "ServiceDeal" d, "ServiceDealFile" f
          WHERE r."dealId" = ${dealId}::int AND f."id" = ${fileId}::int AND ${attachable(userId)}
            AND ${attachedCount} < ${SERVICE_DEAL_REVIEW_IMAGE_MAX}
          ON CONFLICT DO NOTHING`;
      });
      if (!linked) {
        // Lost to a change since the check: the copy was never shown, so it goes rather than lingers.
        const { deleteImages } = await import('~/server/services/image.service');
        await deleteImages([image.id], {
          updatePosts: false,
          actor: { system: 'creator-service-deal-review' },
        });
        throw notAttachable();
      }

      return { imageId: image.id };
    }
  );
  if (!attached)
    throw new TRPCError({ code: 'CONFLICT', message: 'Another image is being added. Try again.' });
  return attached;
}

/** The shown images of a review, in attach order; `includeHidden` for a moderator. */
export async function getReviewImages({
  reviewId,
  levels,
  includeHidden = false,
}: {
  reviewId: number;
  levels: number;
  includeHidden?: boolean;
}) {
  return dbWrite.$queryRaw<{ id: number; url: string; nsfwLevel: number }[]>`
    SELECT i."id", i."url", ${reviewImageLevelSql} AS "nsfwLevel"
    FROM "ServiceDealReviewImage" ri
    JOIN "Image" i ON i."id" = ri."imageId"
    JOIN "ServiceDealReview" r ON r."id" = ri."reviewId"
    JOIN "ServiceDeal" d ON d."id" = r."dealId"
    WHERE ri."reviewId" = ${reviewId}::int AND ${reviewImageVisibleSql(levels, { includeHidden })}
    ORDER BY i."id"`;
}
