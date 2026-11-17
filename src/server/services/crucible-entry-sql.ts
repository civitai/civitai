import { Prisma } from '@prisma/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/** `enteredImageWhere` for entry image `i`. */
const enteredEntryImageSql = Prisma.sql`
  i."needsReview" IS NULL
  AND NOT i."tosViolation"
  AND EXISTS (SELECT 1 FROM "Post" ep WHERE ep.id = i."postId" AND ep."publishedAt" IS NOT NULL)
`;

/**
 * Entry image `i` as someone else may see it: still scanned and published as `submitEntry` required
 * (a review hold, a ToS flag or an unpublished post can come later), still inside the crucible's
 * levels (a re-rating can move it out), and inside the viewer's level.
 */
export const visibleEntryImageSql = (
  crucibleLevel: number | Prisma.Sql,
  viewerLevel: number
) => Prisma.sql`
  i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
  AND ${enteredEntryImageSql}
  AND (i."nsfwLevel" & ${crucibleLevel}) <> 0
  ${viewerLevel > 0 ? Prisma.sql`AND (i."nsfwLevel" & ${viewerLevel}) <> 0` : Prisma.empty}
`;
