import { Prisma } from '@prisma/client';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldItemImageSql } from '@civitai/shared/held-media';
import { childSafetyImageCase } from '@civitai/db-queries/child-safety-case';
import { toPrismaSql } from '~/server/db/prisma-sql-kysely';

/**
 * True in SQL when an image in the deal file `fileId` names is held for CSAM, a minor, a CSAM report
 * or a child-safety case. A null id holds nothing.
 */
export const finalCsamHeldSql = (fileId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "ServiceDealFileEntry" e JOIN "Image" i ON i."id" = e."imageId"
  -- Refuses serving; entryOnlyOverLevel, which keeps evidence, also counts poi and ingestion.
  WHERE e."fileId" = ${fileId} AND (${Prisma.raw(heldItemImageSql('i'))} OR i.minor IS TRUE
    OR (i.id)::text IN (${Prisma.raw(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)})
    OR ${toPrismaSql(childSafetyImageCase('i'))} IS TRUE))`;
