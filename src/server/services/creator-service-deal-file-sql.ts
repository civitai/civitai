import { Prisma } from '@prisma/client';

/**
 * SQL fragment over a deal's delivery files, for the deal service to AND into its own
 * conditional UPDATE so the check and the status change are one statement. No imports beyond Prisma:
 * the deal service can load this without pulling in storage or image code.
 *
 * It is a correlated subquery on the deal row. `deal` is how the enclosing statement
 * names it, which is the bare table in an UPDATE of "ServiceDeal".
 */
const DEAL = Prisma.sql`"ServiceDeal"`;

/**
 * The seller may mark the round delivered: its preview is Ready (watermarked and scanned clean),
 * unless the offering takes no preview, and at least one Final has been uploaded. A Final still
 * uploading does not count, and neither does one not yet unpacked: a file the unpack step is going
 * to refuse is found before the round is delivered, while the seller can still replace it.
 */
export const dealReadyToDeliver = (deal: Prisma.Sql = DEAL) => Prisma.sql`(
  (${deal}."previewKind" = 'None'::"ServicePreviewKind" OR EXISTS (
    SELECT 1 FROM "ServiceDealFile" p
    WHERE p."dealId" = ${deal}."id" AND p."round" = ${deal}."revisionsUsed"
      AND p."kind" = 'Preview'::"ServiceDealFileKind" AND p."status" = 'Ready'::"ServiceDealFileStatus"
  ))
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" p
    WHERE p."dealId" = ${deal}."id" AND p."round" = ${deal}."revisionsUsed"
      AND p."kind" = 'Preview'::"ServiceDealFileKind" AND p."status" <> 'Ready'::"ServiceDealFileStatus"
  )
  AND EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND f."kind" = 'Final'::"ServiceDealFileKind" AND f."status" = 'Ready'::"ServiceDealFileStatus"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND f."kind" = 'Final'::"ServiceDealFileKind"
      AND (f."status" <> 'Ready'::"ServiceDealFileStatus" OR f."unpackedAt" IS NULL)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND f."kind" = 'Final'::"ServiceDealFileKind" AND f."scanStatus" = 'Failed'::"ServiceDealFileScanStatus"
  )
)`;
