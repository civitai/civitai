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
 * A file its uploader has not removed. Every party-facing read, gate, count and job start ANDs this
 * in; only moderator reads and work already in flight see removed rows.
 */
export const liveFile = (f: Prisma.Sql) => Prisma.sql`${f}."removedAt" IS NULL`;

/** How long our own scan-copy delete may take to settle before its marked entry counts as dangling. */
export const SCAN_COPY_SETTLE_WINDOW_MINUTES = 30;

type GoneOptions = {
  /** Leave out entries our own copy delete marked within the settle window: still settling. */
  exceptSettling?: boolean;
};

/** The entry `e` still points at an image that is gone. */
export const entryImageGone = (e: Prisma.Sql, { exceptSettling = false }: GoneOptions = {}) =>
  Prisma.sql`(${e}."imageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i."id" = ${e}."imageId")${
    exceptSettling
      ? Prisma.sql`
  AND (${e}."copyDeleteStartedAt" IS NULL
    OR ${e}."copyDeleteStartedAt" < now() - ${SCAN_COPY_SETTLE_WINDOW_MINUTES}::int * interval '1 minute')`
      : Prisma.empty
  })`;

/**
 * An entry of the file still points at an image that is gone, so nothing shows the image was not
 * held: the file is refused to everyone and does not count as clear. `f` names the file row.
 */
export const fileImageGone = (f: Prisma.Sql, options?: GoneOptions) => Prisma.sql`EXISTS (
  SELECT 1 FROM "ServiceDealFileEntry" e
  WHERE e."fileId" = ${f}."id" AND ${entryImageGone(Prisma.sql`e`, options)}
)`;

/**
 * The kinds the Final scan pipeline (unpack, repack, malware scan, verdict) runs on, as text to
 * compare `"kind"::text` with: the pipeline must keep running on a database that does not have the
 * Attachment value yet. Only the scan steps use it: what gates delivery and payout counts Finals
 * alone.
 */
export const SCANNED_FILE_KINDS = Prisma.sql`'Final', 'Attachment'`;

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
      AND ${liveFile(Prisma.sql`p`)}
      AND p."kind" = 'Preview'::"ServiceDealFileKind" AND p."status" = 'Ready'::"ServiceDealFileStatus"
  ))
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" p
    WHERE p."dealId" = ${deal}."id" AND p."round" = ${deal}."revisionsUsed"
      AND ${liveFile(Prisma.sql`p`)}
      AND p."kind" = 'Preview'::"ServiceDealFileKind" AND p."status" <> 'Ready'::"ServiceDealFileStatus"
  )
  AND EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND ${liveFile(Prisma.sql`f`)}
      AND f."kind" = 'Final'::"ServiceDealFileKind" AND f."status" = 'Ready'::"ServiceDealFileStatus"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND ${liveFile(Prisma.sql`f`)}
      AND f."kind" = 'Final'::"ServiceDealFileKind"
      AND (f."status" <> 'Ready'::"ServiceDealFileStatus" OR f."unpackedAt" IS NULL)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceDealFile" f
    WHERE f."dealId" = ${deal}."id" AND f."round" = ${deal}."revisionsUsed"
      AND ${liveFile(Prisma.sql`f`)}
      AND f."kind" = 'Final'::"ServiceDealFileKind" AND f."scanStatus" = 'Failed'::"ServiceDealFileScanStatus"
  )
)`;
