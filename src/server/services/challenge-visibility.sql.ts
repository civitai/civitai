import { Prisma } from '@prisma/client';

/**
 * The scan and cover gates a public challenge list applies to challenge `c`. The viewer's own
 * challenges pass each gate, so a creator can preview a pending one. Without a viewer, they are
 * the part of public visibility that holds for everyone: the challenge search index keeps exactly
 * these, and the per-viewer and time gates are applied at query time. The detail page applies
 * the same rules in TypeScript (getChallengeDetail, isChallengeHiddenByPoiCover).
 */
export function challengeScanGates(viewerId?: number): Prisma.Sql[] {
  const own = (sql: Prisma.Sql) =>
    viewerId ? Prisma.sql`(${sql} OR c."createdById" = ${viewerId})` : sql;
  return [
    own(Prisma.sql`c."ingestion" = 'Scanned'::"ChallengeIngestionStatus"`),
    // A challenge with no cover image is incomplete.
    Prisma.sql`c."coverImageId" IS NOT NULL`,
    // Image.poi: the cover depicts a real person.
    own(
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."poi" = true)`
    ),
    // The cover's own scan, for user challenges: System and Mod covers are trusted, as on the
    // detail page (getChallengeDetail).
    own(
      Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"))`
    ),
  ];
}

/**
 * Which challenges the semantic search index keeps: the viewer-independent gates, and every status
 * but Cancelled. The event-engine's CHALLENGE_ELIGIBLE_SQL is a copy, pinned by the
 * challenge-eligibility parity test.
 */
export const challengeSemanticEligibleWhere: Prisma.Sql[] = [
  ...challengeScanGates(),
  Prisma.sql`c.status <> 'Cancelled'::"ChallengeStatus"`,
];
