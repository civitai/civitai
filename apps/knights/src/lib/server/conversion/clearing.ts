import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export type ClearingBatch = {
  scanned: number;
  players: number;
  gold: number;
  lastPlayerId: number;
};

const ts = (date: Date) => sql`${date.toISOString()}::timestamp`;

/**
 * Clears the earned gold of up to `limit` players, past `afterPlayerId`, as of one detection run: gold earned
 * (its vote settled, or its Watch completed) at or before `completedAt` becomes convertible. Gold earned after
 * the run waits for the next one. Held players are not touched, so their gold stays frozen and is cleared by a
 * pass that finds them released. Repeating a batch clears nothing more.
 *
 * One statement: the candidates are row-locked in id order, so it serialises with votes and conversions on the player row.
 */
export async function clearGoldBatch(
  db: Kysely<DB>,
  run: { id: number; completedAt: Date },
  { afterPlayerId, limit }: { afterPlayerId: number; limit: number }
): Promise<ClearingBatch> {
  const { rows } = await sql<{
    scanned: number;
    players: number;
    gold: number;
    last: number | null;
  }>`
    WITH cand AS (
      SELECT p."userId", p."goldEarned", p."goldCleared"
      FROM "NewOrderPlayer" p
      WHERE p."userId" > ${afterPlayerId}
        AND p."goldEarned" > p."goldCleared"
        AND p."payoutBlockedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = p."userId" AND u."bannedAt" IS NOT NULL)
      ORDER BY p."userId"
      LIMIT ${limit}
      FOR UPDATE OF p
    ), target AS (
      SELECT c."userId", c."goldCleared" AS "was",
        LEAST(c."goldEarned", GREATEST(c."goldCleared",
          c."goldEarned"
          - COALESCE((
              SELECT sum(v."gold") FROM "KnightsVote" v
              WHERE v."playerId" = c."userId" AND v."gold" > 0 AND v."settledAt" > ${ts(
                run.completedAt
              )}
            ), 0)
          - COALESCE((
              SELECT sum(d."bonusGold") FROM "KnightsPlayerDay" d
              WHERE d."playerId" = c."userId" AND d."day" >= ${ts(run.completedAt)}::date
                AND d."watchCompletedAt" > ${ts(run.completedAt)}
            ), 0)
        )) AS "now"
      FROM cand c
    ), upd AS (
      UPDATE "NewOrderPlayer" p SET "goldCleared" = t."now"
      FROM target t
      WHERE p."userId" = t."userId" AND t."now" > t."was"
      RETURNING p."userId", t."now" - t."was" AS "gold"
    ), logged AS (
      INSERT INTO "KnightsGoldClearing" ("playerId", "runId", "gold")
      SELECT "userId", ${run.id}, "gold" FROM upd
      ON CONFLICT ("playerId", "runId") DO UPDATE
        SET "gold" = "KnightsGoldClearing"."gold" + EXCLUDED."gold", "clearedAt" = CURRENT_TIMESTAMP
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM cand)::int AS "scanned",
      (SELECT count(*) FROM upd)::int AS "players",
      COALESCE((SELECT sum("gold") FROM upd), 0)::int AS "gold",
      (SELECT max("userId") FROM cand) AS "last"
  `.execute(db);
  const row = rows[0];
  return {
    scanned: Number(row.scanned),
    players: Number(row.players),
    gold: Number(row.gold),
    lastPlayerId: row.last == null ? afterPlayerId : Number(row.last),
  };
}
