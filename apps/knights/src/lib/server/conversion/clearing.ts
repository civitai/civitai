import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { heldSql } from './held';

export type ClearingBatch = {
  scanned: number;
  players: number;
  gold: number;
  lastPlayerId: number;
};

/**
 * Clears gold earned (vote settled, Watch completed) at or before `completedAt`; later gold waits for the next run.
 * Held players are skipped. The batch's player rows are locked first and the gold is computed in a second statement,
 * so every settle that was waiting on those rows is committed and visible to it.
 */
export async function clearGoldBatch(
  db: Kysely<DB>,
  run: { id: number; completedAt: Date },
  { afterPlayerId, limit }: { afterPlayerId: number; limit: number }
): Promise<ClearingBatch> {
  return db.transaction().execute(async (trx) => {
    const { rows: locked } = await sql<{ userId: number }>`
      SELECT p."userId" FROM "NewOrderPlayer" p
      WHERE p."userId" > ${afterPlayerId}
        AND p."goldEarned" > p."goldCleared"
        AND NOT ${heldSql('p.userId')}
      ORDER BY p."userId"
      LIMIT ${limit}
      FOR UPDATE OF p
    `.execute(trx);
    if (locked.length === 0) {
      return { scanned: 0, players: 0, gold: 0, lastPlayerId: afterPlayerId };
    }
    const ids = locked.map((r) => Number(r.userId));

    const { rows } = await sql<{ players: number; gold: number }>`
      WITH cand AS (
        SELECT p."userId", p."goldEarned", p."goldCleared"
        FROM "NewOrderPlayer" p
        WHERE p."userId" IN (${sql.join(ids)})
          AND p."goldEarned" > p."goldCleared"
          AND NOT ${heldSql('p.userId')}
      ), target AS (
        SELECT c."userId", c."goldCleared" AS "was",
          LEAST(c."goldEarned", GREATEST(c."goldCleared",
            c."goldEarned"
            - COALESCE((
                SELECT sum(v."gold") FROM "KnightsVote" v
                WHERE v."playerId" = c."userId" AND v."gold" > 0 AND v."settledAt" > ${utc(
                  run.completedAt
                )}
              ), 0)
            - COALESCE((
                SELECT sum(d."bonusGold") FROM "KnightsPlayerDay" d
                WHERE d."playerId" = c."userId" AND d."day" >= ${utc(run.completedAt)}::date
                  AND d."watchCompletedAt" > ${utc(run.completedAt)}
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
        (SELECT count(*) FROM upd)::int AS "players",
        COALESCE((SELECT sum("gold") FROM upd), 0)::int AS "gold"
    `.execute(trx);
    return {
      scanned: ids.length,
      players: Number(rows[0].players),
      gold: Number(rows[0].gold),
      lastPlayerId: ids[ids.length - 1],
    };
  });
}
