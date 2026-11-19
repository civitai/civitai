import { clickhouse } from '~/server/clickhouse/client';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbReadLong } from '~/server/db/pgDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createJob } from './job';
import {
  HOT_RANK_DAILY_TABLE,
  HOT_RANK_RUNS_TABLE,
  HOT_RANK_STAGING_TABLE,
  hotRankSnapshotSql,
  toHotRankRows,
  type HotRankSnapshotArrays,
} from './model-hot-rank-snapshot.sql';

// Time the full statement on the replica before arming the flag (DDL file, Preflight).
const READ_TIMEOUT_MS = 60 * 1000;
const INSERT_BATCH = 50_000;
// The shared client inserts async without waiting, which would let the read-back below run before
// the rows land and would swallow insert errors.
const SYNC_INSERT = { async_insert: 0 } as const;

async function readOne<T>(query: string): Promise<T | undefined> {
  if (!clickhouse) return undefined;
  // A read straight after a write on a replicated table can land on a replica that has not seen it.
  const res = await clickhouse.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: { select_sequential_consistency: '1' },
  });
  const [row] = await res.json<T>();
  return row;
}

/**
 * One row per Hot-ranked model per UTC day, in ClickHouse. Tables, retention and the rollout are in
 * src/server/clickhouse/migrations/2026-11-19-model-hot-rank-daily.sql.
 *
 * A day is written to staging, checked there, then swapped into the daily table in one
 * REPLACE PARTITION, and only then marked complete in the runs table. So a failed or cancelled run
 * never touches a good day, and a day that is already marked complete is skipped: past scores and
 * paid states cannot be rebuilt, so a lost night is lost for good.
 */
export const modelHotRankSnapshotJob = createJob(
  'model-hot-rank-snapshot',
  '20 4 * * *',
  async (jobContext) => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_HOT_RANK_SNAPSHOT))) {
      return { skipped: 'flag-off' };
    }
    if (!clickhouse) return { skipped: 'clickhouse-unavailable' };
    const ch = clickhouse;

    const day = new Date().toISOString().slice(0, 10);
    const done = await readOne<{ n: number }>(
      `SELECT count() AS n FROM ${HOT_RANK_RUNS_TABLE} WHERE day = '${day}'`
    );
    if (Number(done?.n ?? 0) > 0) return { skipped: 'complete', day };

    const { rows } = await queryWithTimeout<HotRankSnapshotArrays>(
      pgDbReadLong,
      READ_TIMEOUT_MS,
      hotRankSnapshotSql
    );
    const snapshot = rows[0];
    const total = snapshot?.modelIds.length ?? 0;
    if (!total) throw new Error('model-hot-rank-snapshot: the snapshot read returned no models');

    jobContext.checkIfCanceled();
    await ch.$exec(`ALTER TABLE ${HOT_RANK_STAGING_TABLE} DROP PARTITION '${day}'`);
    for (let start = 0; start < total; start += INSERT_BATCH) {
      jobContext.checkIfCanceled();
      await ch.insert({
        table: HOT_RANK_STAGING_TABLE,
        values: toHotRankRows(snapshot, day, start, start + INSERT_BATCH),
        format: 'JSONEachRow',
        clickhouse_settings: SYNC_INSERT,
      });
    }

    const check = await readOne<{ rows: number; ranks: number; maxRank: number }>(
      `SELECT count() AS rows, uniqExact(rank) AS ranks, max(rank) AS maxRank
       FROM ${HOT_RANK_STAGING_TABLE} WHERE day = '${day}'`
    );
    const got = [check?.rows, check?.ranks, check?.maxRank].map(Number);
    if (got.some((n) => n !== total)) {
      throw new Error(
        `model-hot-rank-snapshot: staging for ${day} holds rows/ranks/maxRank ${got.join(
          '/'
        )}, expected ${total}`
      );
    }

    jobContext.checkIfCanceled();
    await ch.$exec(
      `ALTER TABLE ${HOT_RANK_DAILY_TABLE} REPLACE PARTITION '${day}' FROM ${HOT_RANK_STAGING_TABLE}`
    );
    await ch.insert({
      table: HOT_RANK_RUNS_TABLE,
      values: [{ day, rows: total }],
      format: 'JSONEachRow',
      clickhouse_settings: SYNC_INSERT,
    });
    await ch.$exec(`ALTER TABLE ${HOT_RANK_STAGING_TABLE} DROP PARTITION '${day}'`);

    return { day, rows: total };
  },
  // Covers the read's own timeout plus the inserts. keepLockOnDisconnect so a scheduler hang-up does
  // not free the lock for a second run of the same day while this one is still writing.
  { lockExpiration: 30 * 60, keepLockOnDisconnect: true }
);
