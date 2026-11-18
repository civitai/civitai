import { Prisma } from '@prisma/client';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';

/**
 * Crucible `c` and its cover `i` have both passed their scans, and the cover is rated, neither in
 * review nor a ToS violation: every list surface requires it. getCrucibles builds the same rule as a
 * Prisma filter (crucibleCoverListedWhere).
 */
export const crucibleScannedSql = Prisma.sql`c.ingestion = ${CrucibleIngestionStatus.Scanned}::"CrucibleIngestionStatus"
  AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
  AND i."nsfwLevel" != 0 AND i."needsReview" IS NULL AND NOT i."tosViolation"`;

/** The cover half of crucibleScannedSql, as a Prisma filter on the crucible's `image`. */
export const crucibleCoverListedWhere = {
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: { notIn: [0] },
  needsReview: null,
  tosViolation: false,
} satisfies Prisma.ImageWhereInput;

/**
 * Which crucibles the semantic search index keeps: the scans every list surface requires, a cover
 * that is not minor, POI or blocked, not Cancelled, not taken down, and an owner who is not banned or
 * deleted. The event-engine's
 * CRUCIBLE_ELIGIBLE_SQL is a copy, pinned by the crucible-eligibility parity test. The viewer's
 * levels, textNsfw and the green-site gate are applied per query.
 */
export const crucibleSemanticEligibleWhere: Prisma.Sql[] = [
  crucibleScannedSql,
  Prisma.sql`NOT i.minor AND NOT i.poi AND NOT ${hasBlockMarkerSql('i')}`,
  Prisma.sql`c.status <> ${CrucibleStatus.Cancelled}::"CrucibleStatus"`,
  Prisma.sql`c."takenDownAt" IS NULL`,
  Prisma.sql`NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = c."userId"
    AND (u."bannedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL))`,
];

/** The cover fields isCrucibleHiddenByScan reads: select them wherever it is called. */
export const crucibleCoverScanSelect = {
  ingestion: true,
  nsfwLevel: true,
  needsReview: true,
  tosViolation: true,
} satisfies Prisma.ImageSelect;
