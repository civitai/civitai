import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { ComparisonPhase, PairwiseVerdict } from './challenge-pairwise';

export type StandingRow = { imageId: number; userId: number; rank: number; comparisons: number };

/** The ladder as it stands, best first. */
export async function getStandings(challengeId: number): Promise<StandingRow[]> {
  return dbWrite.$queryRaw<StandingRow[]>`
    SELECT "imageId", "userId", "rank", "comparisons"
    FROM "ChallengeEntryStanding"
    WHERE "challengeId" = ${challengeId}
    ORDER BY "rank" ASC
  `;
}

/**
 * Insert one entry at `rank`, pushing everything at or below it down a place. Two statements in a
 * transaction because the shift has to be invisible to readers mid-way: a concurrent read between
 * them would see two entries sharing a rank.
 */
export async function insertStanding(input: {
  challengeId: number;
  imageId: number;
  userId: number;
  rank: number;
  comparisons: number;
}): Promise<void> {
  const { challengeId, imageId, userId, rank, comparisons } = input;
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      UPDATE "ChallengeEntryStanding"
      SET "rank" = "rank" + 1
      WHERE "challengeId" = ${challengeId} AND "rank" >= ${rank} AND "imageId" <> ${imageId}
    `,
    dbWrite.$executeRaw`
      INSERT INTO "ChallengeEntryStanding" ("challengeId", "imageId", "userId", "rank", "comparisons")
      VALUES (${challengeId}, ${imageId}, ${userId}, ${rank}, ${comparisons})
      ON CONFLICT ("challengeId", "imageId")
      DO UPDATE SET "rank" = EXCLUDED."rank",
                    "comparisons" = "ChallengeEntryStanding"."comparisons" + EXCLUDED."comparisons",
                    "updatedAt" = now()
    `,
  ]);
}

/**
 * How many distinct comparisons each image took part in, across every phase. Derived from the
 * comparison rows because they are the only durable record — the arrival count on the standing is
 * overwritten by every reorder.
 */
export async function countComparisonsByImage(challengeId: number): Promise<Map<number, number>> {
  const rows = await dbWrite.$queryRaw<{ imageId: number; count: bigint }[]>`
    SELECT "imageId", COUNT(*) AS count
    FROM (
      SELECT "imageIdA" AS "imageId" FROM "ChallengeEntryComparison" WHERE "challengeId" = ${challengeId}
      UNION ALL
      SELECT "imageIdB" AS "imageId" FROM "ChallengeEntryComparison" WHERE "challengeId" = ${challengeId}
    ) AS sides
    GROUP BY "imageId"
  `;
  return new Map(rows.map((row) => [row.imageId, Number(row.count)]));
}

/**
 * Overwrite the whole ladder — the second run and the podium both re-order the entire field.
 *
 * `comparisons` is RECOUNTED here rather than taken from the caller. Both callers used to pass
 * nothing, so every reorder silently reset the column to 0 and the per-entry count that plan item
 * 10 asks for survived only in ChallengeEntryComparison — a column that reads as "this entry was
 * never compared" for an entry that was compared nine times. Deriving it means a third caller
 * cannot reintroduce that by omission.
 */
export async function replaceStandings(
  challengeId: number,
  rows: { imageId: number; userId: number; winRate?: number | null }[]
): Promise<void> {
  const comparisonCounts = await countComparisonsByImage(challengeId);
  const values = rows.map(
    (row, i) =>
      Prisma.sql`(${challengeId}, ${row.imageId}, ${row.userId}, ${i + 1}, ${
        comparisonCounts.get(row.imageId) ?? 0
      }, ${row.winRate ?? null})`
  );
  await dbWrite.$transaction([
    dbWrite.$executeRaw`DELETE FROM "ChallengeEntryStanding" WHERE "challengeId" = ${challengeId}`,
    ...(values.length
      ? [
          dbWrite.$executeRaw`
            INSERT INTO "ChallengeEntryStanding"
              ("challengeId", "imageId", "userId", "rank", "comparisons", "winRate")
            VALUES ${Prisma.join(values)}
          `,
        ]
      : []),
  ]);
}

export type StoredComparison = {
  imageIdA: number;
  imageIdB: number;
  winnerImageId: number | null;
  firstSeatImageId: number;
  reason: string | null;
};

/** Comparisons already paid for in this challenge, for the cache and the podium tally. */
export async function getComparisons(
  challengeId: number,
  phases: ComparisonPhase[]
): Promise<StoredComparison[]> {
  if (!phases.length) return [];
  return dbWrite.$queryRaw<StoredComparison[]>`
    SELECT "imageIdA", "imageIdB", "winnerImageId", "firstSeatImageId", "reason"
    FROM "ChallengeEntryComparison"
    WHERE "challengeId" = ${challengeId}
      AND "phase" IN (${Prisma.join(phases)})
  `;
}

/**
 * Persist a verdict. Pair columns are stored low-id first so the same two images are one row
 * whichever of them was the challenger; `firstSeatImageId` keeps the seating that produced it.
 */
export async function recordComparison(input: {
  challengeId: number;
  phase: ComparisonPhase;
  verdict: PairwiseVerdict;
}): Promise<void> {
  const { challengeId, phase, verdict } = input;
  const [imageIdA, imageIdB] = [verdict.imageIdA, verdict.imageIdB].sort((a, b) => a - b);
  await dbWrite.$executeRaw`
    INSERT INTO "ChallengeEntryComparison"
      ("challengeId", "phase", "imageIdA", "imageIdB", "firstSeatImageId", "winnerImageId",
       "margin", "model", "rerouted", "perCategory", "reason", "buzzCost")
    VALUES (${challengeId}, ${phase}, ${imageIdA}, ${imageIdB}, ${verdict.firstSeatImageId},
            ${verdict.winnerImageId}, ${verdict.margin}, ${verdict.model}, ${verdict.rerouted},
            ${verdict.perCategory as Prisma.InputJsonValue}, ${verdict.reason},
            ${Math.ceil(verdict.buzzCost)})
    ON CONFLICT ("challengeId", "phase", "imageIdA", "imageIdB", "firstSeatImageId") DO NOTHING
  `;
}
