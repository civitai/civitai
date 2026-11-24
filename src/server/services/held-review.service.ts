import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { ReportStatus } from '~/shared/utils/prisma/enums';

/** A report still open, as `r.status IN ${openReportStatusesSql}`. */
export const openReportStatusesSql = Prisma.sql`(${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")`;

/**
 * Drops the copies of deleted storylines (`deleteStoryline`) once they are a year old and no report
 * on them is open, with their chapter copies. Chapter copies with no storyline copy are leftovers
 * of chapter removals, which no longer copy; they go now. One statement, so a storyline's copy never loses its chapters
 * while it stays.
 */
export async function purgeReleasedHeldCopies() {
  const ofStoryline = (chapterId: Prisma.Sql, storylines: Prisma.Sql) => Prisma.sql`EXISTS (
    SELECT 1 FROM "HeldStorylineChapter" c WHERE c.id = ${chapterId} AND c."storylineId" IN (${storylines})
  )`;
  const releasedIds = Prisma.sql`SELECT id FROM released`;
  const keptIds = Prisma.sql`SELECT id FROM "HeldStoryline" WHERE id NOT IN (${releasedIds})`;
  const [counts] = await dbWrite.$queryRaw<
    { storylines: number; chapters: number; edges: number; choices: number; clicks: number }[]
  >`
    WITH released AS (
      DELETE FROM "HeldStoryline" hs
      WHERE hs."deletedAt" < now() - interval '1 year'
        AND NOT EXISTS (
          SELECT 1 FROM "Report" r
          WHERE r.status IN ${openReportStatusesSql}
            AND (
              r.id = ANY(hs."reportIds")
              OR r.id IN (SELECT sr."reportId" FROM "StorylineReport" sr WHERE sr."heldStorylineId" = hs.id)
            )
        )
      RETURNING hs.id
    ),
    chapters AS (
      DELETE FROM "HeldStorylineChapter" h WHERE h."storylineId" NOT IN (${keptIds}) RETURNING 1
    ),
    edges AS (
      DELETE FROM "HeldStorylineChapterEdge" h WHERE h."storylineId" NOT IN (${keptIds}) RETURNING 1
    ),
    choices AS (
      DELETE FROM "HeldStorylineBranchChoice" h
      WHERE NOT ${ofStoryline(Prisma.raw('h."chapterId"'), keptIds)}
      RETURNING 1
    ),
    clicks AS (
      DELETE FROM "HeldStorylineCreateClick" h
      WHERE NOT ${ofStoryline(Prisma.raw('h."parentChapterId"'), keptIds)}
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM released)::int AS storylines,
      (SELECT count(*) FROM chapters)::int AS chapters,
      (SELECT count(*) FROM edges)::int AS edges,
      (SELECT count(*) FROM choices)::int AS choices,
      (SELECT count(*) FROM clicks)::int AS clicks
  `;
  return counts;
}
