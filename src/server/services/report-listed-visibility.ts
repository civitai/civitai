import { Prisma } from '@prisma/client';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL } from '@civitai/shared/held-media';
import { dbRead } from '~/server/db/client';

/**
 * Not listed on a CsamReport, as SQL over `"Image" i`: the bounty search index's exclusion, for a
 * viewer without the held-media grant. Its uploader still sees it.
 */
export const notReportListedSql = (userId?: number) =>
  Prisma.sql`((i.id)::text NOT IN (${Prisma.raw(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)})${
    userId ? Prisma.sql` OR i."userId" = ${userId}` : Prisma.empty
  })`;

/** Who may see images listed on a CsamReport: `seesReportListed(ctx)`, and the uploader on a
 *  session or a full-access key. */
export type ReportListedViewer = {
  userId?: number;
  seesReportListed: boolean;
  ownerSeesReportListed?: boolean;
};

const notListedFor = ({ userId, ownerSeesReportListed }: ReportListedViewer) =>
  notReportListedSql(ownerSeesReportListed ? userId : undefined);

/** A read with no viewer: the search indexes, og images, shared documents. */
export const SIGNED_OUT_REPORT_LISTED: ReportListedViewer = { seesReportListed: false };

/** SQL over `"Image" i`: this viewer may see the image under the report-listed rule. */
export const reportListedImageSql = (viewer: ReportListedViewer) =>
  viewer.seesReportListed ? Prisma.sql`TRUE` : notListedFor(viewer);

/** SQL: the image `idSql` names is one this viewer may see under the report-listed rule. */
export const reportListedVisibleSql = (idSql: Prisma.Sql, viewer: ReportListedViewer) =>
  viewer.seesReportListed
    ? Prisma.sql`TRUE`
    : Prisma.sql`NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ${idSql} AND NOT ${notListedFor(
        viewer
      )})`;

/** The ids among `imageIds` this viewer may not see under the report-listed rule. */
export async function getReportListedHiddenImageIds(
  imageIds: number[],
  viewer: ReportListedViewer,
  db: Pick<typeof dbRead, '$queryRaw'> = dbRead
): Promise<Set<number>> {
  if (viewer.seesReportListed || imageIds.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i
    WHERE i.id IN (${Prisma.join(imageIds)}) AND NOT ${notListedFor(viewer)}
  `;
  return new Set(rows.map((row) => row.id));
}
