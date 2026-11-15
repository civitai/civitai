import { Prisma } from '@prisma/client';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';

/**
 * Crucible `c` and its cover `i` have both passed their scans, and the cover is neither in review
 * nor a ToS violation: every list surface requires it. getCrucibles builds the same rule as a
 * Prisma filter (crucibleCoverListedWhere).
 */
export const crucibleScannedSql = Prisma.sql`c.ingestion = ${CrucibleIngestionStatus.Scanned}::"CrucibleIngestionStatus"
  AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
  AND i."needsReview" IS NULL AND NOT i."tosViolation"`;

/** The cover half of crucibleScannedSql, as a Prisma filter on the crucible's `image`. */
export const crucibleCoverListedWhere = {
  ingestion: ImageIngestionStatus.Scanned,
  needsReview: null,
  tosViolation: false,
} satisfies Prisma.ImageWhereInput;

/**
 * Which crucibles the semantic search index keeps: the scans every list surface requires, not
 * Cancelled and not taken down, as the public feed (getCrucibles). The event-engine's
 * CRUCIBLE_ELIGIBLE_SQL is a copy, pinned by the crucible-eligibility parity test. The viewer's
 * levels, textNsfw and the green-site gate are applied per query.
 */
export const crucibleSemanticEligibleWhere: Prisma.Sql[] = [
  crucibleScannedSql,
  Prisma.sql`c.status <> ${CrucibleStatus.Cancelled}::"CrucibleStatus"`,
  Prisma.sql`c."takenDownAt" IS NULL`,
];

/** The cover fields isCrucibleHiddenByScan reads: select them wherever it is called. */
export const crucibleCoverScanSelect = {
  ingestion: true,
  needsReview: true,
  tosViolation: true,
} satisfies Prisma.ImageSelect;
