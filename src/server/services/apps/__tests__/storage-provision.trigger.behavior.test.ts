import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What `AppStorageProvisioner`'s per-user quota TRIGGER does to real rows, as
 * opposed to what its SQL text says.
 *
 * 🔴 WHY THIS IS EXECUTED AND NOT STRING-ASSERTED. Every other provisioner test
 * captures the SQL handed to a mocked `client.query` and asserts on the string.
 * That is blind to the two mutations that matter most here, both of which were
 * confirmed to SURVIVE a fully green string-asserting suite:
 *
 *   1. invert the DELETE branch so a delete ADDS `OLD.size_bytes` instead of
 *      subtracting it — the counter then only ever climbs, and a user who
 *      deletes everything they own still reads as full;
 *   2. replace the INSERT branch's `ON CONFLICT … DO UPDATE SET used_bytes =
 *      user_quota.used_bytes + EXCLUDED.used_bytes …` with `DO NOTHING` — the
 *      counter freezes at whatever the user's FIRST write cost and the per-user
 *      cap never binds again, i.e. the feature is permanently inert.
 *
 * Both spellings contain the same identifiers in the same order, so no
 * text assertion can separate them from the correct one. Running the
 * provisioner's own, unmodified DDL on an in-process Postgres and then writing
 * rows through it can.
 *
 * THE ORACLE IS NOT THE TRIGGER. Expected values are pinned as literals computed
 * from the fixture payloads by hand, and separately cross-checked against a
 * `sum(size_bytes)`/`count(*)` aggregate over `kv` — a different mechanism
 * (recompute) from the one under test (incremental maintenance). A counter that
 * disagrees with the rows it summarises is the whole class of bug this catches.
 */

const holder = {
  db: null as unknown as PGlite,
};

/**
 * Route one statement at the in-process database.
 *
 * Parameterized statements go through the extended protocol (`query`);
 * everything else through the simple protocol (`exec`), which is what parses
 * dollar-quoted function bodies and `DO $do$ … $do$` blocks server-side. Sending
 * those through `query` would fail on the embedded semicolons.
 */
async function runSql(sql: string, params?: unknown[]) {
  if (params && params.length > 0) {
    return await holder.db.query(sql, params as unknown[]);
  }
  const results = await holder.db.exec(sql);
  return results[results.length - 1] ?? { rows: [] };
}

// PGlite is a single session, so one shared connection stands in for the pool.
// `release` is a no-op for the same reason. Session state (an open transaction,
// a `SET LOCAL`) therefore persists across calls exactly as it does on one real
// pooled connection — which is the property the trigger depends on.
const fakeClient = {
  query: (sql: string, params?: unknown[]) => runSql(sql, params),
  release: () => undefined,
};
const fakePool = {
  connect: async () => fakeClient,
  query: (sql: string, params?: unknown[]) => runSql(sql, params),
};

vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => fakePool,
}));

const { AppStorageProvisioner } = await import('~/server/services/apps/storage-provision.service');

const SLUG = 'quota_trigger_probe';
const SCHEMA = `"app_${SLUG}"`;
const APP_BLOCK_ID = 'apb_trigger_probe';
const OTHER_APP_BLOCK_ID = 'apb_trigger_probe_two';
const INSTANCE = 'mbi_probe';

// Two subjects, so a per-user counter that is really an app-wide counter in
// disguise cannot pass. Ids are distinct from every byte count and row count
// asserted below, so no expectation can be satisfied by the wrong column.
const USER_A = 7001;
const USER_B = 8002;

/**
 * The payloads, and the byte cost of each.
 *
 * `size_bytes` is `octet_length(value::text)` on a jsonb column, so a JSON
 * string of N ASCII characters costs N + 2 (the two quotes). Lengths are
 * pairwise distinct, distinct from every row count in play (1, 2, 3), and none
 * is a multiple of another — so a mutant that swaps one term for another, or
 * confuses bytes with rows, cannot land on the right answer by arithmetic
 * accident.
 */
const ALPHA = 'a'.repeat(37); // 39 bytes stored
const BETA = 'b'.repeat(53); // 55 bytes stored
const GAMMA = 'c'.repeat(11); // 13 bytes stored
const ALPHA_SMALL = 'a'.repeat(5); // 7 bytes stored
const BETA_BIG = 'b'.repeat(89); // 91 bytes stored

const ALPHA_BYTES = 39;
const BETA_BYTES = 55;
const GAMMA_BYTES = 13;
const ALPHA_SMALL_BYTES = 7;
const BETA_BIG_BYTES = 91;

/**
 * Write exactly the way `apps.storage.set` writes: one transaction, the GUC set
 * with `SET LOCAL` on the same connection, then the upsert. If the GUC is not
 * set the trigger deliberately no-ops, so this shape is load-bearing — a test
 * that skipped it would measure nothing and report zeroes as agreement.
 */
async function setKv(appBlockId: string, userId: number, key: string, value: unknown) {
  await runSql('BEGIN');
  await runSql(`SET LOCAL app.current_app_block_id = '${appBlockId}'`);
  await runSql(
    `INSERT INTO ${SCHEMA}.kv (block_instance_id, user_id, key, value)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (block_instance_id, user_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [INSTANCE, userId, key, JSON.stringify(value)]
  );
  await runSql('COMMIT');
}

/** The delete path, same transaction shape. */
async function deleteKv(appBlockId: string, userId: number, key: string) {
  await runSql('BEGIN');
  await runSql(`SET LOCAL app.current_app_block_id = '${appBlockId}'`);
  await runSql(
    `DELETE FROM ${SCHEMA}.kv WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
    [INSTANCE, userId, key]
  );
  await runSql('COMMIT');
}

/** What the trigger claims. */
async function readUserCounter(appBlockId: string, userId: number) {
  const r = await runSql(
    `SELECT used_bytes::int AS used_bytes, row_count::int AS row_count
       FROM ${SCHEMA}.user_quota WHERE app_block_id = $1 AND user_id = $2`,
    [appBlockId, userId]
  );
  const row = (r.rows as Array<{ used_bytes: number; row_count: number }>)[0];
  return row ? { usedBytes: row.used_bytes, rowCount: row.row_count } : null;
}

/** What the rows actually say — the independent recompute oracle. */
async function recomputeUser(userId: number) {
  const r = await runSql(
    `SELECT COALESCE(sum(size_bytes), 0)::int AS used_bytes, count(*)::int AS row_count
       FROM ${SCHEMA}.kv WHERE user_id = $1`,
    [userId]
  );
  const row = (r.rows as Array<{ used_bytes: number; row_count: number }>)[0];
  return { usedBytes: row.used_bytes, rowCount: row.row_count };
}

async function readAppCounter(appBlockId: string) {
  const r = await runSql(
    `SELECT used_bytes::int AS used_bytes, row_count::int AS row_count
       FROM ${SCHEMA}.quota WHERE app_block_id = $1`,
    [appBlockId]
  );
  const row = (r.rows as Array<{ used_bytes: number; row_count: number }>)[0];
  return row ? { usedBytes: row.used_bytes, rowCount: row.row_count } : null;
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.waitReady;
});

beforeEach(async () => {
  // A fresh schema per test: `provision` is idempotent, so re-running it is the
  // real production path, but the ROWS must not carry between cases or a later
  // assertion would be reading an earlier one's residue.
  await runSql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await AppStorageProvisioner.provision({ appBlockId: APP_BLOCK_ID, slug: SLUG });
});

describe('AppStorageProvisioner per-user quota trigger (executed against real Postgres)', () => {
  // POSITIVE CONTROL for the harness itself. If `provision` silently produced no
  // trigger — or the GUC never reached the session — every counter would read 0
  // and every "counter matches recompute" assertion below would pass vacuously
  // on 0 === 0. This case fails in that world, so it is what licenses the rest.
  it('a single insert moves the counter off zero by exactly the stored size', async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES,
      rowCount: 1,
    });
    // The literal above and the recompute agree — two independent statements of
    // the same fact, so a wrong fixture size cannot hide behind a wrong counter.
    expect(await recomputeUser(USER_A)).toEqual({ usedBytes: ALPHA_BYTES, rowCount: 1 });
  });

  // 🔴 KILLS THE `DO NOTHING` MUTATION. The first insert CREATES the counter row,
  // so a frozen ON CONFLICT branch is invisible until a SECOND insert by the SAME
  // user has to fold into it. Under `DO NOTHING` this reads 39/1 instead of 94/2.
  it('a second insert by the same user ACCUMULATES into their existing counter', async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA);

    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES, // 94
      rowCount: 2,
    });
    expect(await recomputeUser(USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES,
      rowCount: 2,
    });
  });

  // 🔴 KILLS THE INVERTED-DELETE MUTATION. A delete that adds instead of
  // subtracting reads 94/1 here (bytes up, rows down) rather than 55/1.
  it('a delete SUBTRACTS the removed row from the counter', async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA);
    await deleteKv(APP_BLOCK_ID, USER_A, 'alpha');

    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: BETA_BYTES, // 55
      rowCount: 1,
    });
    expect(await recomputeUser(USER_A)).toEqual({ usedBytes: BETA_BYTES, rowCount: 1 });
  });

  // The full insert → update-up → update-down → delete walk, asserted against
  // the recompute at EVERY step. An update must move bytes and NOT rows; the
  // shrink leg is the one that catches a `+` where the code needs `NEW - OLD`.
  it('counter tracks ground truth across insert, grow, shrink and delete', async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES,
      rowCount: 1,
    });

    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA);
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES, // 94
      rowCount: 2,
    });

    // GROW an existing key: bytes rise by the delta, row count is untouched.
    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA_BIG);
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BIG_BYTES, // 130
      rowCount: 2,
    });

    // SHRINK an existing key: bytes fall by the delta, row count still untouched.
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA_SMALL);
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_SMALL_BYTES + BETA_BIG_BYTES, // 98
      rowCount: 2,
    });

    await deleteKv(APP_BLOCK_ID, USER_A, 'beta');
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_SMALL_BYTES, // 7
      rowCount: 1,
    });

    await deleteKv(APP_BLOCK_ID, USER_A, 'alpha');
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({ usedBytes: 0, rowCount: 0 });
    expect(await recomputeUser(USER_A)).toEqual({ usedBytes: 0, rowCount: 0 });
  });

  // The relationship the whole sub-quota exists to create: one user's writes must
  // not appear in another user's counter, while BOTH fold into the app counter.
  // Two independently-passing per-user tests would not pin this.
  it("one user's writes stay out of the other's counter and both reach the app counter", async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA);
    await setKv(APP_BLOCK_ID, USER_B, 'alpha', GAMMA);

    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES, // 94
      rowCount: 2,
    });
    expect(await readUserCounter(APP_BLOCK_ID, USER_B)).toEqual({
      usedBytes: GAMMA_BYTES, // 13
      rowCount: 1,
    });
    expect(await readAppCounter(APP_BLOCK_ID)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES + GAMMA_BYTES, // 107
      rowCount: 3,
    });

    // Deleting A's row leaves B's counter exactly where it was.
    await deleteKv(APP_BLOCK_ID, USER_A, 'alpha');
    expect(await readUserCounter(APP_BLOCK_ID, USER_B)).toEqual({
      usedBytes: GAMMA_BYTES,
      rowCount: 1,
    });
  });

  // The backfill path F1's fallback depends on: rows written while the GUC was
  // unset (i.e. before this feature, when no per-user trigger existed) are folded
  // in by `provision`'s anti-join seed, and a re-run does not double-count them.
  it('re-running provision SEEDS pre-existing rows once and never clobbers a live counter', async () => {
    // No GUC → both triggers no-op, which is exactly the pre-feature world.
    await runSql(
      `INSERT INTO ${SCHEMA}.kv (block_instance_id, user_id, key, value)
       VALUES ($1, $2, 'alpha', $3::jsonb), ($1, $4, 'alpha', $5::jsonb)`,
      [INSTANCE, USER_A, JSON.stringify(ALPHA), USER_B, JSON.stringify(GAMMA)]
    );
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toBeNull();

    await AppStorageProvisioner.provision({ appBlockId: APP_BLOCK_ID, slug: SLUG });
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES,
      rowCount: 1,
    });
    expect(await readUserCounter(APP_BLOCK_ID, USER_B)).toEqual({
      usedBytes: GAMMA_BYTES,
      rowCount: 1,
    });

    // A live write, then ANOTHER provision. The seed must skip both users now
    // that they have counter rows — a seed that re-ran would report 39 + 39.
    await setKv(APP_BLOCK_ID, USER_A, 'beta', BETA);
    await AppStorageProvisioner.provision({ appBlockId: APP_BLOCK_ID, slug: SLUG });
    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES, // 94, not 133
      rowCount: 2,
    });
  });

  // The counter is keyed on (app_block_id, user_id), and the GUC is what supplies
  // the app half. A write under a different app id must open a separate counter
  // rather than adding to the first — this is what makes the `set` gate's
  // `WHERE app_block_id = $1 AND user_id = $2` read the right row.
  it('counters are partitioned by the app id the write ran under', async () => {
    await setKv(APP_BLOCK_ID, USER_A, 'alpha', ALPHA);
    await setKv(OTHER_APP_BLOCK_ID, USER_A, 'beta', BETA);

    expect(await readUserCounter(APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: ALPHA_BYTES,
      rowCount: 1,
    });
    expect(await readUserCounter(OTHER_APP_BLOCK_ID, USER_A)).toEqual({
      usedBytes: BETA_BYTES,
      rowCount: 1,
    });
  });
});

/**
 * `provisionReviewPreview` carries a SECOND, textually independent copy of the
 * same trigger body. A guard on only the `provision` copy would leave the twin
 * free to regress in exactly the two ways above — a mutation applied to the
 * preview copy alone would SURVIVE, which is the failure mode this block exists
 * to close. Same assertions, same oracle, different provisioner.
 */
describe('provisionReviewPreview per-user quota trigger (executed against real Postgres)', () => {
  const PUBREQ = 'pubreq_probe01';
  const PREVIEW_SCHEMA = '"apprev_pubreqprobe01"';

  async function previewSet(userId: number, key: string, value: unknown) {
    await runSql('BEGIN');
    await runSql(`SET LOCAL app.current_app_block_id = '${PUBREQ}'`);
    await runSql(
      `INSERT INTO ${PREVIEW_SCHEMA}.kv (block_instance_id, user_id, key, value)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (block_instance_id, user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [INSTANCE, userId, key, JSON.stringify(value)]
    );
    await runSql('COMMIT');
  }

  async function previewDelete(userId: number, key: string) {
    await runSql('BEGIN');
    await runSql(`SET LOCAL app.current_app_block_id = '${PUBREQ}'`);
    await runSql(
      `DELETE FROM ${PREVIEW_SCHEMA}.kv WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
      [INSTANCE, userId, key]
    );
    await runSql('COMMIT');
  }

  async function previewCounter(userId: number) {
    const r = await runSql(
      `SELECT used_bytes::int AS used_bytes, row_count::int AS row_count
         FROM ${PREVIEW_SCHEMA}.user_quota WHERE app_block_id = $1 AND user_id = $2`,
      [PUBREQ, userId]
    );
    const row = (r.rows as Array<{ used_bytes: number; row_count: number }>)[0];
    return row ? { usedBytes: row.used_bytes, rowCount: row.row_count } : null;
  }

  beforeEach(async () => {
    // DROP first: the provisioner fast-paths on an existing `user_quota`, so a
    // schema left over from the previous case would skip the DDL under test.
    await runSql(`DROP SCHEMA IF EXISTS ${PREVIEW_SCHEMA} CASCADE`);
    await AppStorageProvisioner.provisionReviewPreview({ publishRequestId: PUBREQ });
  });

  it('accumulates a second insert and subtracts a delete, same as the approved path', async () => {
    await previewSet(USER_A, 'alpha', ALPHA);
    expect(await previewCounter(USER_A)).toEqual({ usedBytes: ALPHA_BYTES, rowCount: 1 });

    // Kills the preview copy's `DO NOTHING` mutation.
    await previewSet(USER_A, 'beta', BETA);
    expect(await previewCounter(USER_A)).toEqual({
      usedBytes: ALPHA_BYTES + BETA_BYTES, // 94
      rowCount: 2,
    });

    // Kills the preview copy's inverted-DELETE mutation.
    await previewDelete(USER_A, 'alpha');
    expect(await previewCounter(USER_A)).toEqual({ usedBytes: BETA_BYTES, rowCount: 1 });
  });

  it('tracks a shrink in place without moving the row count', async () => {
    await previewSet(USER_A, 'alpha', ALPHA);
    await previewSet(USER_A, 'alpha', ALPHA_SMALL);
    expect(await previewCounter(USER_A)).toEqual({
      usedBytes: ALPHA_SMALL_BYTES, // 7
      rowCount: 1,
    });
  });

  // The fast path added by this PR probes `user_quota`, NOT the schema, so a
  // preview provisioned by an EARLIER build (schema + kv + quota, no user_quota)
  // upgrades on the next op instead of leaving every write hitting a missing
  // relation. Simulate that older shape by dropping just the one table.
  it('upgrades a preview schema that predates user_quota instead of fast-pathing past it', async () => {
    await runSql(`DROP TABLE ${PREVIEW_SCHEMA}.user_quota`);
    await AppStorageProvisioner.provisionReviewPreview({ publishRequestId: PUBREQ });
    await previewSet(USER_A, 'alpha', ALPHA);
    expect(await previewCounter(USER_A)).toEqual({ usedBytes: ALPHA_BYTES, rowCount: 1 });
  });
});
