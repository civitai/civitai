import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  reconcileRunnerAttempts,
  RUNNER_ATTEMPT_STALE_MS,
  sweepRunnerAttempts,
  type RunnerReconcileDeps,
} from '~/server/services/blocks/runner-reconcile.service';

/**
 * The runner ledger jobs over the real migrations: the reconciler settles a terminal workflow from
 * the attempt row and moves its Redis legs once, however many reconcilers race on it; the sweeper
 * releases stalled attempts and never refunds one that may have been sent. Ids are invented.
 */

const MIGRATIONS = [
  '20271204120000_recipe_runner_ledger',
  '20271205120000_recipe_runner_reservation',
].map((m) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${m}/migration.sql`)
);
const USER = 990000401;
const NOW = new Date('2026-11-26T12:00:00Z');
const LEGS = {
  buzzCapKey: 'system:blocks:buzz-cap:990000401:2026-11-26',
  consentBudgetKey: 'system:blocks:consent-budget:990000401:apb_r:2026-11-26',
  appSpendKey: 'system:blocks:app-spend:apb_r:2026-11-26',
  amount: 90,
};

let pg: PGlite;
const db = pgliteKysely(() => pg);

async function insertAttempt(over: {
  id: string;
  state: string;
  updatedAt?: Date;
  workflowId?: string | null;
  reservation?: object | null;
}) {
  await pg.query(
    `INSERT INTO runner_run_attempts (attempt_id, run_id, attempt_no, user_id, runner_client_id,
       app_block_id, authorization_id, state, reserved_amount, workflow_id, external_id,
       updated_at, reservation)
     VALUES ($1, $1, 1, $2, 'rcl_r', 'apb_r', 'rra_r', $3, 90, $4, 'block:apb_r:' || $1, $5, $6)`,
    [
      over.id,
      USER,
      over.state,
      over.workflowId === undefined ? `${USER}-wf-${over.id}` : over.workflowId,
      over.updatedAt ?? new Date(NOW.getTime() - 60_000),
      over.reservation === undefined ? JSON.stringify(LEGS) : over.reservation,
    ]
  );
}

const row = async (id: string) =>
  (
    await pg.query<{ state: string; charged_amount: number | null; settled_at: Date | null }>(
      `SELECT state, charged_amount, settled_at FROM runner_run_attempts WHERE attempt_id = $1`,
      [id]
    )
  ).rows[0];

function orchestrator(workflow: Record<string, unknown> | null) {
  const deps = {
    getWorkflow: vi.fn(async (id: string) => (workflow ? { id, ...workflow } : null)),
    cancelWorkflow: vi.fn(async (): Promise<number | undefined> => 200),
    markWorkflowStatus: vi.fn(async () => 1),
    reverseAuthorFee: vi.fn(async () => ({ reversed: false })),
  };
  return deps as typeof deps & RunnerReconcileDeps;
}

const done = (total: number, status = 'succeeded') => ({
  status,
  tags: ['app-block:app_r'],
  cost: { total },
});

beforeEach(async () => {
  vi.clearAllMocks();
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.redis.set.mockImplementation((async () => 'OK') as never);
  redisMock.redis.del.mockImplementation((async () => 1) as never);
  redisMock.sysRedis.decrBy.mockImplementation((async () => 0) as never);
  redisMock.sysRedis.incrBy.mockImplementation((async () => 0) as never);
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "OauthClient" (id text PRIMARY KEY);
    CREATE TABLE app_blocks (id text PRIMARY KEY, app_id text);
    CREATE TABLE "OauthConsent" (id serial PRIMARY KEY, "userId" int, "clientId" text);
    INSERT INTO "User" VALUES (${USER});
    INSERT INTO "OauthClient" VALUES ('rcl_r');
    INSERT INTO app_blocks VALUES ('apb_r', 'app_r');
  `);
  for (const m of MIGRATIONS) await pg.exec(readFileSync(m, 'utf8'));
  await pg.exec(`
    INSERT INTO runner_run_authorizations (id, user_id, runner_client_id, kind, run_id,
        recipe_version_hash, params_hash, max_amount_per_run, created_at, expires_at)
      VALUES ('rra_r', ${USER}, 'rcl_r', 'single', 'run_r', 'r', 'p', 100,
        '2026-11-26 00:00:00+00', '2026-11-26 20:00:00+00');
  `);
});

describe('reconcileRunnerAttempts', () => {
  it('settles a succeeded workflow from the row and refunds each leg down to the actual cost', async () => {
    await insertAttempt({ id: 'rat_a', state: 'submitted' });
    const counts = await reconcileRunnerAttempts(db, orchestrator(done(30)), NOW);
    expect(counts).toMatchObject({ settled: 1 });
    expect(await row('rat_a')).toMatchObject({ state: 'settled', charged_amount: 30 });
    expect((await row('rat_a')).settled_at).not.toBeNull();
    expect(redisMock.sysRedis.decrBy.mock.calls).toEqual([
      [LEGS.buzzCapKey, 60],
      [LEGS.appSpendKey, 60],
      [LEGS.consentBudgetKey, 60],
    ]);
  });

  it('a failed workflow that charged nothing is refunded, and its author fee reversed', async () => {
    await insertAttempt({ id: 'rat_f', state: 'submitted' });
    const deps = orchestrator(done(0, 'failed'));
    await reconcileRunnerAttempts(db, deps, NOW);
    expect(await row('rat_f')).toMatchObject({ state: 'refunded', charged_amount: 0 });
    expect(redisMock.sysRedis.decrBy).toHaveBeenCalledWith(LEGS.buzzCapKey, 90);
    expect(deps.reverseAuthorFee).toHaveBeenCalledWith(`${USER}-wf-rat_f`, 'failed');
    expect(deps.markWorkflowStatus).toHaveBeenCalledWith(`${USER}-wf-rat_f`, 'failed');
  });

  it('a charge past the ceiling is adopted on every leg and alarmed as drift', async () => {
    await insertAttempt({ id: 'rat_o', state: 'submitted' });
    await reconcileRunnerAttempts(db, orchestrator(done(120)), NOW);
    expect(await row('rat_o')).toMatchObject({ state: 'settled', charged_amount: 120 });
    expect(redisMock.sysRedis.incrBy.mock.calls).toEqual([
      [LEGS.buzzCapKey, 30],
      [LEGS.appSpendKey, 30],
      [LEGS.consentBudgetKey, 30],
    ]);
  });

  it('two reconcilers racing on one attempt move the legs exactly once', async () => {
    await insertAttempt({ id: 'rat_r', state: 'submitted' });
    const deps = orchestrator(done(30));
    const results = await Promise.all([
      reconcileRunnerAttempts(db, deps, NOW),
      reconcileRunnerAttempts(db, deps, NOW),
    ]);
    expect(results.map((c) => c.settled).sort()).toEqual([0, 1]);
    expect(redisMock.sysRedis.decrBy).toHaveBeenCalledTimes(3); // each leg, once
    expect(await row('rat_r')).toMatchObject({ state: 'settled', charged_amount: 30 });
  });

  it('backs a held attempt off, so it is not polled again in the next passes', async () => {
    await insertAttempt({ id: 'rat_h', state: 'submitted' });
    const deps = orchestrator(null);
    expect(await reconcileRunnerAttempts(db, deps, new Date())).toMatchObject({ held: 1 });
    expect(await reconcileRunnerAttempts(db, deps, new Date())).toMatchObject({ held: 0 });
    expect(deps.getWorkflow).toHaveBeenCalledTimes(1);
    expect((await row('rat_h')).state).toBe('submitted');
  });

  it('cancels on the live usage estimate while cost.total still reads 0', async () => {
    await insertAttempt({ id: 'rat_live', state: 'submitted' });
    const deps = orchestrator({
      status: 'processing',
      tags: ['app-block:app_r'],
      cost: { total: 0 },
      steps: [{ $type: 'customComfy', output: { usage: { estimatedCost: 91.2 } } }],
    });
    deps.cancelWorkflow.mockResolvedValueOnce(200);
    await reconcileRunnerAttempts(db, deps, NOW);
    expect(deps.cancelWorkflow).toHaveBeenCalledWith(`${USER}-wf-rat_live`);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'runner-attempt-over-ceiling',
        payload: expect.objectContaining({ observedCost: 92, ceiling: 90, status: 200 }),
      })
    );
  });

  it('a cancel the orchestrator refuses releases its marker, so the next run retries it', async () => {
    await insertAttempt({ id: 'rat_cf', state: 'submitted' });
    const deps = orchestrator(done(95, 'processing'));
    deps.cancelWorkflow.mockRejectedValueOnce(
      Object.assign(new Error('cancelWorkflow failed'), { status: 403 })
    );
    await reconcileRunnerAttempts(db, deps, NOW);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: 'cancel_failed', status: 403 }),
      })
    );
    expect(redisMock.redis.del).toHaveBeenCalledWith('blocks:runner-over-ceiling-cancel:rat_cf');
    await reconcileRunnerAttempts(db, deps, NOW);
    expect(deps.cancelWorkflow).toHaveBeenCalledTimes(2);
  });

  it('holds a workflow owned by another user, and settles nothing', async () => {
    await insertAttempt({ id: 'rat_x', state: 'submitted', workflowId: '777-wf-x' });
    expect(await reconcileRunnerAttempts(db, orchestrator(done(1)), NOW)).toMatchObject({
      held: 1,
      settled: 0,
    });
    expect((await row('rat_x')).state).toBe('submitted');
    expect(redisMock.sysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('holds a workflow not tagged for the app, and settles nothing', async () => {
    await insertAttempt({ id: 'rat_t', state: 'submitted' });
    const orch = orchestrator({ ...done(1), tags: ['app-block:app_other'] });
    expect(await reconcileRunnerAttempts(db, orch, NOW)).toMatchObject({ held: 1, settled: 0 });
    expect((await row('rat_t')).state).toBe('submitted');
    expect(redisMock.sysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('cancels a running workflow past its reserved ceiling once, and never refunds it', async () => {
    await insertAttempt({ id: 'rat_c', state: 'submitted' });
    const orch = orchestrator(done(95, 'processing'));
    await reconcileRunnerAttempts(db, orch, NOW);
    expect(orch.cancelWorkflow).toHaveBeenCalledWith(`${USER}-wf-rat_c`);
    redisMock.redis.set.mockImplementation((async () => null) as never); // the marker is held
    await reconcileRunnerAttempts(db, orch, NOW);
    expect(orch.cancelWorkflow).toHaveBeenCalledTimes(1);
    expect((await row('rat_c')).state).toBe('submitted');
    expect(redisMock.sysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('leaves a running workflow within its ceiling alone', async () => {
    await insertAttempt({ id: 'rat_w', state: 'submitted' });
    const orch = orchestrator(done(90, 'processing'));
    expect(await reconcileRunnerAttempts(db, orch, NOW)).toMatchObject({ running: 1 });
    expect(orch.cancelWorkflow).not.toHaveBeenCalled();
  });
});

describe('sweepRunnerAttempts', () => {
  const stale = new Date(NOW.getTime() - RUNNER_ATTEMPT_STALE_MS - 1000);
  const fresh = new Date(NOW.getTime() - RUNNER_ATTEMPT_STALE_MS + 60_000);

  it('refunds a stale reserved attempt and moves a stale submitting one to unknown, unrefunded', async () => {
    await insertAttempt({ id: 'rat_s1', state: 'reserved', updatedAt: stale, reservation: null });
    await insertAttempt({ id: 'rat_s2', state: 'submitting', updatedAt: stale, workflowId: null });
    await insertAttempt({ id: 'rat_s3', state: 'reserved', updatedAt: fresh, reservation: null });
    expect(await sweepRunnerAttempts(db, NOW)).toMatchObject({ refunded: 1, unknown: 1 });
    expect((await row('rat_s1')).state).toBe('refunded');
    expect((await row('rat_s2')).state).toBe('unknown');
    expect((await row('rat_s3')).state).toBe('reserved');
    expect(redisMock.sysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('counts unknown attempts held for more than an hour', async () => {
    await insertAttempt({
      id: 'rat_u',
      state: 'unknown',
      updatedAt: new Date(NOW.getTime() - 61 * 60_000),
    });
    expect(await sweepRunnerAttempts(db, NOW)).toMatchObject({ unknownStale: 1 });
  });
});
