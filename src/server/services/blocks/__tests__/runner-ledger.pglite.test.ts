import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { SYSTEM_CLIENT_OWNER_ID } from '~/server/services/blocks/runner-mint.service';
import {
  readRunnerAttemptState,
  reserveRunnerAttempt,
  transitionRunnerAttempt,
} from '~/server/services/blocks/runner-ledger.service';

/**
 * The attempt ledger over the real migration: the reserve re-runs every mint check against what
 * is committed, refuses a second live attempt per run, and moves attempts only from the state a
 * caller names. PGlite has one connection, so the `FOR UPDATE` lock itself is not exercised
 * here; the race below is caught by the partial unique index. Ids are invented.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20271204120000_recipe_runner_ledger/migration.sql'
);
const USER = 990000301;
const CLIENT = 'rcl_ledger';
const APP_BLOCK = 'apb_ledger';
const NOW = new Date('2026-11-26T12:00:00Z');

let pg: PGlite;
const db = pgliteKysely(() => pg);

const reserve = (over: Partial<Parameters<typeof reserveRunnerAttempt>[1]> = {}) =>
  reserveRunnerAttempt(db, {
    userId: USER,
    clientId: CLIENT,
    authorizationId: 'rra_single',
    runKey: 'run_one',
    runId: 'run_one',
    appBlockId: APP_BLOCK,
    amount: 50,
    externalId: `block:${APP_BLOCK}:run_one`,
    now: NOW,
    ...over,
  });

const attempts = async () =>
  (
    await pg.query<{ run_id: string; attempt_no: number; state: string }>(
      `SELECT run_id, attempt_no, state FROM runner_run_attempts ORDER BY run_id, attempt_no`
    )
  ).rows;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "OauthClient" (id text PRIMARY KEY, "userId" int, "isConfidential" boolean,
      "skipConsent" boolean, grants text[], "accessMode" text);
    CREATE TABLE app_blocks (id text PRIMARY KEY, app_id text, block_id text, status text);
    CREATE TABLE "OauthConsent" (id serial PRIMARY KEY, "userId" int, "clientId" text,
      "offlineGrantedAt" timestamp(3));
    INSERT INTO "User" VALUES (${USER});
    INSERT INTO "OauthClient" VALUES
      ('${CLIENT}', ${SYSTEM_CLIENT_OWNER_ID}, true, false, '{authorization_code}', 'open');
    INSERT INTO app_blocks VALUES ('${APP_BLOCK}', 'app_x', 'blk_x', 'approved');
  `);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  await pg.exec(`
    INSERT INTO runner_client_bindings (runner_client_id, app_block_id, created_by_user_id)
      VALUES ('${CLIENT}', '${APP_BLOCK}', 1);
    INSERT INTO "OauthConsent" ("userId", "clientId", "offlineGrantedAt", "offlineBuzzLimit", "offlineBuzzPeriod")
      VALUES (${USER}, '${CLIENT}', '2026-11-20 00:00:00', 120, 'week');
    INSERT INTO runner_run_authorizations (id, user_id, runner_client_id, kind, run_id,
        recipe_version_hash, params_hash, max_amount_per_run, created_at, expires_at)
      VALUES ('rra_single', ${USER}, '${CLIENT}', 'single', 'run_one', 'r', 'p', 100,
        '2026-11-26 00:00:00+00', '2026-11-26 20:00:00+00');
    INSERT INTO runner_run_authorizations (id, user_id, runner_client_id, kind,
        recipe_version_hash, params_hash, max_amount_per_run, max_runs_per_period, period,
        created_at, expires_at)
      VALUES ('rra_standing', ${USER}, '${CLIENT}', 'standing', 'r', 'p', 40, 2, 'day',
        '2026-11-25 00:00:00+00', '2026-12-20 00:00:00+00');
  `);
});

describe('reserveRunnerAttempt', () => {
  it('inserts the first attempt of a run in reserved', async () => {
    const r = await reserve();
    expect(r).toMatchObject({ ok: true, attemptNo: 1 });
    expect(await attempts()).toEqual([{ run_id: 'run_one', attempt_no: 1, state: 'reserved' }]);
  });

  it('two concurrent reserves on one run leave exactly one attempt', async () => {
    // PGlite serialises them, so the second is refused by the live-attempt read, not the index.
    const results = await Promise.all([reserve(), reserve()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, refusal: 'run_live' }]);
    expect(await attempts()).toHaveLength(1);
  });

  it('a reserve that loses the insert race on the unique index refuses as run_live', async () => {
    // Stands in for a concurrent reserve committing between this one's checks and its insert.
    await pg.exec(`
      CREATE FUNCTION lose_race() RETURNS trigger AS $$
      BEGIN
        RAISE unique_violation USING MESSAGE = 'runner_run_attempts_one_live_per_run';
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER lose_race BEFORE INSERT ON runner_run_attempts
        FOR EACH ROW EXECUTE FUNCTION lose_race();
    `);
    expect(await reserve()).toEqual({ ok: false, refusal: 'run_live' });
  });

  it('the partial unique index allows one live attempt per run, and more once settled out', async () => {
    const row = (no: number, state: string) =>
      pg.query(
        `INSERT INTO runner_run_attempts (attempt_id, run_id, attempt_no, user_id, runner_client_id,
           app_block_id, authorization_id, state, reserved_amount, external_id)
         VALUES ($1, 'run_idx', $2, ${USER}, '${CLIENT}', '${APP_BLOCK}', 'rra_single', $3, 10, 'x')`,
        [`att_idx_${no}`, no, state]
      );
    await row(1, 'refunded');
    await row(2, 'unknown');
    await expect(row(3, 'reserved')).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a run that already holds a live attempt, and allows a new one once it is refunded', async () => {
    const first = await reserve();
    expect(await reserve()).toEqual({ ok: false, refusal: 'run_live' });
    if (!first.ok) throw new Error('first reserve refused');
    expect(await transitionRunnerAttempt(db, first.attemptId, 'reserved', 'refunded')).toBe(true);
    expect(await reserve()).toMatchObject({ ok: true, attemptNo: 2 });
  });

  it('counts the offline cap from the ledger: a reserve past it is refused', async () => {
    const { standingRunId } = await import('~/server/services/blocks/runner-mint.service');
    const run = (key: string) => standingRunId('rra_standing', key);
    expect(
      await reserve({ authorizationId: 'rra_standing', runKey: 't1', runId: run('t1'), amount: 40 })
    ).toMatchObject({ ok: true });
    expect(
      await reserve({ authorizationId: 'rra_standing', runKey: 't2', runId: run('t2'), amount: 40 })
    ).toMatchObject({ ok: true });
    // Runs per period (2 per day) is reached before the cap (120) here.
    expect(
      await reserve({ authorizationId: 'rra_standing', runKey: 't3', runId: run('t3'), amount: 40 })
    ).toEqual({ ok: false, refusal: 'runs_per_period' });
    // The single authorization's run would fit its own 100 per run, but 80 of the 120 cap is held.
    expect(await reserve({ amount: 50 })).toEqual({ ok: false, refusal: 'cap' });
    expect(await reserve({ amount: 40 })).toMatchObject({ ok: true });
  });

  it('refuses a token whose run id is not the one its authorization derives', async () => {
    expect(await reserve({ runId: 'run_other' })).toEqual({ ok: false, refusal: 'run_mismatch' });
    expect(await attempts()).toEqual([]);
  });

  it('refuses with no consent row, and once the authorization is revoked', async () => {
    expect(await reserve({ userId: USER + 1 })).toEqual({ ok: false, refusal: 'consent' });
    await pg.exec(
      `UPDATE runner_run_authorizations SET revoked_at = now() WHERE id = 'rra_single'`
    );
    expect(await reserve()).toEqual({ ok: false, refusal: 'authorization' });
  });
});

describe('transitionRunnerAttempt', () => {
  it('moves an attempt only from the state the caller names', async () => {
    const r = await reserve();
    if (!r.ok) throw new Error('reserve refused');
    expect(await transitionRunnerAttempt(db, r.attemptId, 'submitting', 'unknown')).toBe(false);
    expect(await transitionRunnerAttempt(db, r.attemptId, 'reserved', 'submitting')).toBe(true);
    expect(await transitionRunnerAttempt(db, r.attemptId, 'reserved', 'refunded')).toBe(false);
    expect(
      await transitionRunnerAttempt(db, r.attemptId, 'submitting', 'submitted', {
        workflowId: 'wf_1',
      })
    ).toBe(true);
    expect(await readRunnerAttemptState(db, r.attemptId)).toBe('submitted');
    const { rows } = await pg.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM runner_run_attempts WHERE attempt_id = $1`,
      [r.attemptId]
    );
    expect(rows[0].workflow_id).toBe('wf_1');
  });

  it('refuses a move the state machine does not have', async () => {
    await expect(transitionRunnerAttempt(db, 'rat_x', 'unknown', 'refunded')).rejects.toThrow(
      /no transition unknown -> refunded/
    );
  });

  it('an unknown attempt holds its run: no new attempt, and it keeps counting against the cap', async () => {
    const r = await reserve({ amount: 100 });
    if (!r.ok) throw new Error('reserve refused');
    await transitionRunnerAttempt(db, r.attemptId, 'reserved', 'submitting');
    await transitionRunnerAttempt(db, r.attemptId, 'submitting', 'unknown');
    expect(await reserve()).toEqual({ ok: false, refusal: 'run_live' });
    const { standingRunId } = await import('~/server/services/blocks/runner-mint.service');
    expect(
      await reserve({
        authorizationId: 'rra_standing',
        runKey: 't1',
        runId: standingRunId('rra_standing', 't1'),
        amount: 40,
      })
    ).toEqual({ ok: false, refusal: 'cap' });
  });
});
