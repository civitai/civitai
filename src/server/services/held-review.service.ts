import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  accountHoldReasonsSql,
  accountHoldSql,
  holdMarkerViewExists,
} from '~/server/services/legal-hold.service';
import { ReportStatus } from '~/shared/utils/prisma/enums';

/** A report still open, as `r.status IN ${openReportStatusesSql}`. */
export const openReportStatusesSql = Prisma.sql`(${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")`;

/**
 * A `WITH` entry, ahead of a DELETE that cascades "ResourceReview", that copies each review a held
 * author wrote among `reviews` (a query selecting review ids) into "HeldResourceReview". In the
 * DELETE's own statement, so a hold landing between two statements cannot skip the copy.
 */
export function keepHeldReviewsCte(reviews: Prisma.Sql, markerView: boolean): Prisma.Sql {
  const author = Prisma.raw('r."userId"');
  return Prisma.sql`held_reviews AS (
    INSERT INTO "HeldResourceReview" (
      id, "modelId", "modelVersionId", "userId", rating, recommended, details, exclude, nsfw,
      "tosViolation", metadata, "createdAt", "updatedAt", "holdReasons"
    )
    SELECT r.id, r."modelId", r."modelVersionId", r."userId", r.rating, r.recommended, r.details,
      r.exclude, r.nsfw, r."tosViolation", r.metadata, r."createdAt", r."updatedAt",
      ${accountHoldReasonsSql(author, markerView)}
    FROM "ResourceReview" r
    WHERE r.id IN (${reviews}) AND ${accountHoldSql(author, markerView)}
    ON CONFLICT (id) DO NOTHING
  )`;
}

/**
 * Whether a held author has an entry under the bounty `bountyId` (an int SQL expression): the bounty
 * is kept, hidden, instead of deleted, so the entry is not cascaded away.
 */
export const heldEntryOnBountySql = (bountyId: Prisma.Sql, markerView: boolean) =>
  Prisma.sql`EXISTS (
    SELECT 1 FROM "BountyEntry" he
    WHERE he."bountyId" = ${bountyId} AND ${accountHoldSql(Prisma.raw('he."userId"'), markerView)}
  )`;

/** The reviews on the models `models` selects, or on their versions: the two can disagree. */
export const reviewsOnModelsSql = (models: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr
    WHERE rr."modelId" IN (${models})
      OR rr."modelVersionId" IN (SELECT mv.id FROM "ModelVersion" mv WHERE mv."modelId" IN (${models}))`;

/** The reviews on the versions `versions` selects. */
export const reviewsOnVersionsSql = (versions: Prisma.Sql) =>
  Prisma.sql`SELECT rr.id FROM "ResourceReview" rr WHERE rr."modelVersionId" IN (${versions})`;

/**
 * A storyline chapter copy is kept while either user it records is held. The reader on a branch
 * choice or create click never releases one, even once their account is gone. The placeholder owner
 * is not held here (accountHoldSql excludes it), so copies owned by it release with their other
 * holds. A copy of a deleted storyline's chapter goes only with that storyline's copy (below).
 */
const storylineCopyReleasedSql = (markerView: boolean) =>
  Prisma.sql`NOT ${accountHoldSql(Prisma.raw('h."ownerId"'), markerView)}
    AND NOT ${accountHoldSql(Prisma.raw('h."authorId"'), markerView)}`;

/**
 * A deleted storyline's copy (`deleteStoryline`) is released once it is a year old, its owner, every
 * chapter author and draft author is unheld, read now, and no report on it is open.
 */
const heldStorylineReleasedSql = (markerView: boolean) => {
  const held = (id: string) => accountHoldSql(Prisma.raw(id), markerView);
  return Prisma.sql`hs."deletedAt" < now() - interval '1 year'
    AND NOT ${held('hs."userId"')}
    AND NOT EXISTS (
      SELECT 1 FROM "HeldStorylineChapter" hc WHERE hc."storylineId" = hs.id AND ${held(
        'hc."userId"'
      )}
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(hs."pendingAuthorIds") AS pa(id) WHERE ${held('pa.id')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Report" r
      WHERE r.status IN ${openReportStatusesSql}
        AND (
          r.id = ANY(hs."reportIds")
          OR r.id IN (SELECT sr."reportId" FROM "StorylineReport" sr WHERE sr."heldStorylineId" = hs.id)
        )
    )`;
};

/** Drops the copies whose users are no longer held. Returns how many went. */
export async function purgeReleasedHeldCopies() {
  const markerView = await holdMarkerViewExists();
  const released = accountHoldSql(Prisma.raw('h."userId"'), markerView);
  const reviews = await dbWrite.$executeRaw`
    DELETE FROM "HeldResourceReview" h WHERE NOT ${released}`;
  // One statement, so a hold placed meanwhile cannot leave a chapter's copy without its edges, or a
  // storyline's copy without its chapters.
  const copyReleased = storylineCopyReleasedSql(markerView);
  // The chapter copy `chapterId` selects goes with its storyline's copy: released now, or kept.
  const ofStoryline = (chapterId: Prisma.Sql, storylines: Prisma.Sql) => Prisma.sql`EXISTS (
    SELECT 1 FROM "HeldStorylineChapter" c WHERE c.id = ${chapterId} AND c."storylineId" IN (${storylines})
  )`;
  const releasedIds = Prisma.sql`SELECT id FROM released`;
  const keptIds = Prisma.sql`SELECT id FROM "HeldStoryline"`;
  const [{ storylines, ...storyline }] = await dbWrite.$queryRaw<
    { storylines: number; chapters: number; edges: number; choices: number; clicks: number }[]
  >`
    WITH released AS (
      DELETE FROM "HeldStoryline" hs WHERE ${heldStorylineReleasedSql(markerView)} RETURNING hs.id
    ),
    chapters AS (
      DELETE FROM "HeldStorylineChapter" h
      WHERE h."storylineId" IN (${releasedIds})
        OR (h."storylineId" NOT IN (${keptIds}) AND ${copyReleased})
      RETURNING 1
    ),
    edges AS (
      DELETE FROM "HeldStorylineChapterEdge" h
      WHERE h."storylineId" IN (${releasedIds})
        OR (h."storylineId" NOT IN (${keptIds}) AND ${copyReleased})
      RETURNING 1
    ),
    choices AS (
      DELETE FROM "HeldStorylineBranchChoice" h
      WHERE ${ofStoryline(Prisma.raw('h."chapterId"'), releasedIds)}
        OR (NOT ${ofStoryline(Prisma.raw('h."chapterId"'), keptIds)} AND ${copyReleased})
      RETURNING 1
    ),
    clicks AS (
      DELETE FROM "HeldStorylineCreateClick" h
      WHERE ${ofStoryline(Prisma.raw('h."parentChapterId"'), releasedIds)}
        OR (NOT ${ofStoryline(Prisma.raw('h."parentChapterId"'), keptIds)} AND ${copyReleased})
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM released)::int AS storylines,
      (SELECT count(*) FROM chapters)::int AS chapters,
      (SELECT count(*) FROM edges)::int AS edges,
      (SELECT count(*) FROM choices)::int AS choices,
      (SELECT count(*) FROM clicks)::int AS clicks
  `;
  return { reviews, storyline, storylines };
}
