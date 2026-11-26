import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runnerMintReads } from '@civitai/db-queries/recipe-runner';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * The runner mint's SQL reads over the real migration: which attempt states count against the
 * offline cap and toward runs per period, and which hold a run live. The decision tests inject fake
 * reads, so this is the only place these queries meet the schema. Ids are invented.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20271204120000_recipe_runner_ledger/migration.sql'
);
const USER = 990000201;
const OTHER_USER = 990000202;
const CLIENT = 'rcl_reads';
const OTHER_CLIENT = 'rcl_other';
const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;
const SINCE = new Date(NOW - 24 * HOUR);

let pg: PGlite;
const reads = runnerMintReads(pgliteKysely(() => pg));

let attemptNo = 0;
async function attempt(a: {
  runId: string;
  state: string;
  reserved: number;
  charged?: number | null;
  ageHours?: number;
  userId?: number;
  clientId?: string;
  authorizationId?: string;
}) {
  attemptNo += 1;
  await pg.query(
    `INSERT INTO runner_run_attempts (attempt_id, run_id, attempt_no, user_id, runner_client_id,
       app_block_id, authorization_id, state, reserved_amount, charged_amount, external_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'apb_reads', $6, $7, $8, $9, $1, $10)`,
    [
      `att_${attemptNo}`,
      a.runId,
      attemptNo,
      a.userId ?? USER,
      a.clientId ?? CLIENT,
      a.authorizationId ?? 'rra_a',
      a.state,
      a.reserved,
      a.charged ?? null,
      new Date(NOW - (a.ageHours ?? 1) * HOUR),
    ]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "OauthClient" (id text PRIMARY KEY);
    CREATE TABLE app_blocks (id text PRIMARY KEY);
    CREATE TABLE "OauthConsent" (id serial PRIMARY KEY, "userId" int, "clientId" text,
      "offlineGrantedAt" timestamp(3));
    INSERT INTO "User" VALUES (${USER}), (${OTHER_USER});
    INSERT INTO "OauthClient" VALUES ('${CLIENT}'), ('${OTHER_CLIENT}');
    INSERT INTO app_blocks VALUES ('apb_reads');
  `);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  await pg.exec(`
    INSERT INTO "OauthConsent" ("userId", "clientId", "offlineGrantedAt", "offlineBuzzLimit", "offlineBuzzPeriod")
      VALUES (${USER}, '${CLIENT}', '2026-11-20 00:00:00', 200, 'week');
  `);
  for (const [id, user, client] of [
    ['rra_a', USER, CLIENT],
    ['rra_b', USER, CLIENT],
    ['rra_other', OTHER_USER, OTHER_CLIENT],
  ] as const) {
    await pg.query(
      `INSERT INTO runner_run_authorizations (id, user_id, runner_client_id, kind, recipe_version_hash,
         params_hash, max_amount_per_run, max_runs_per_period, period, created_at, expires_at)
       VALUES ($1, $2, $3, 'standing', 'v', 'p', 50, 5, 'day', $4, $5)`,
      [id, user, client, new Date(NOW - 48 * HOUR), new Date(NOW + 48 * HOUR)]
    );
  }

  // Counted against the cap (run_live_*, run_settled, run_failed_charged), 10 + 20 + 30 + 40 + 5.
  await attempt({ runId: 'run_live_reserved', state: 'reserved', reserved: 10 });
  await attempt({ runId: 'run_live_unknown', state: 'unknown', reserved: 20 });
  await attempt({ runId: 'run_settled', state: 'settled', reserved: 50, charged: 30 });
  await attempt({ runId: 'run_live_submitted', state: 'submitted', reserved: 40 });
  await attempt({ runId: 'run_failed_charged', state: 'failed', reserved: 50, charged: 5 });
  // Negative controls: none of these may count.
  await attempt({ runId: 'run_failed_free', state: 'failed', reserved: 50 });
  await attempt({ runId: 'run_refunded', state: 'refunded', reserved: 50, charged: 0 });
  await attempt({ runId: 'run_old', state: 'settled', reserved: 50, charged: 50, ageHours: 30 });
  await attempt({ runId: 'run_other_user', state: 'reserved', reserved: 50, userId: OTHER_USER, clientId: OTHER_CLIENT, authorizationId: 'rra_other' }); // prettier-ignore
  await attempt({ runId: 'run_b', state: 'reserved', reserved: 7, authorizationId: 'rra_b' });
});

describe('runnerMintReads over the migration', () => {
  it('capUsed counts live and settled attempts, a failed one at what it was charged, inside the window', async () => {
    // 10 + 20 + 30 + 40 + 5 (rra_a) + 7 (rra_b): every authorization of this user and client.
    expect(await reads.capUsed(USER, CLIENT, SINCE)).toBe(112);
  });

  it('capUsed is zero for a pair with no attempts', async () => {
    expect(await reads.capUsed(OTHER_USER, CLIENT, SINCE)).toBe(0);
  });

  it('runsSince counts distinct runs holding a live or settled attempt in the window', async () => {
    // run_live_reserved, run_live_unknown, run_settled, run_live_submitted; not failed, refunded or old.
    expect(await reads.runsSince('rra_a', SINCE)).toBe(4);
    expect(await reads.runsSince('rra_b', SINCE)).toBe(1);
  });

  it('hasLiveAttempt is true for a live or settled run, false for a failed, refunded or unknown run id', async () => {
    expect(await reads.hasLiveAttempt('run_live_unknown')).toBe(true);
    expect(await reads.hasLiveAttempt('run_settled')).toBe(true);
    expect(await reads.hasLiveAttempt('run_failed_charged')).toBe(false);
    expect(await reads.hasLiveAttempt('run_refunded')).toBe(false);
    expect(await reads.hasLiveAttempt('run_never')).toBe(false);
  });

  // The `AT TIME ZONE 'UTC'` in this read is not observable here: PGlite returns a zoneless
  // timestamp as UTC with or without it (checked by removing it, under a non-UTC session zone).
  it('consent reads the grant time and the cap', async () => {
    expect(await reads.consent(USER, CLIENT)).toEqual({
      offlineGrantedAt: new Date('2026-11-20T00:00:00Z'),
      offlineBuzzLimit: 200,
      offlineBuzzPeriod: 'week',
    });
  });

  it('authorization maps the row', async () => {
    expect(await reads.authorization('rra_a')).toMatchObject({
      id: 'rra_a',
      userId: USER,
      runnerClientId: CLIENT,
      kind: 'standing',
      runId: null,
      maxAmountPerRun: 50,
      maxRunsPerPeriod: 5,
      period: 'day',
      revokedAt: null,
    });
  });
});
