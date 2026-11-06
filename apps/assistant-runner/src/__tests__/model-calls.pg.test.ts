import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgModelCalls, type ModelCallScope } from '../model-calls';
import { freshDatabase, TEST_DATABASE_URL } from '../core/test-support/pg';

const describePg = TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.CI && !TEST_DATABASE_URL)
  throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set in CI');

const scope = (overrides: Partial<ModelCallScope> = {}): ModelCallScope => ({
  runId: 'run-a',
  userId: 'u-1',
  conversationId: 'c-1',
  seq: 3,
  ...overrides,
});

describePg('PgModelCalls', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let pool: pg.Pool;
  let calls: PgModelCalls;

  beforeAll(async () => {
    db = await freshDatabase('model_calls');
    pool = new pg.Pool({ connectionString: db.url, max: 2 });
    calls = new PgModelCalls(pool);
    await calls.init();
    // Every replica creates it at start: a second time is a no-op.
    await new PgModelCalls(pool).init();
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  it('finds the workflow a run’s request was last sent as, and nothing for another key', async () => {
    await calls.save(scope(), 'key-1', 'wf-a1');
    await calls.save(scope(), 'key-1', 'wf-a2');
    expect(await calls.find(scope(), 'key-1')).toBe('wf-a2');
    expect(await calls.find(scope(), 'key-2')).toBeNull();
    // Another run of the same turn does not see it unless it carries on from saved steps.
    expect(await calls.find(scope({ runId: 'run-b' }), 'key-1')).toBeNull();
    expect(await calls.find(scope({ runId: 'run-b', carriesOn: true }), 'key-1')).toBe('wf-a2');
    // Nor any other turn's or user's, carrying on or not.
    for (const other of [{ seq: 4 }, { conversationId: 'c-2' }, { userId: 'u-2' }])
      expect(
        await calls.find(scope({ runId: 'run-b', carriesOn: true, ...other }), 'key-1')
      ).toBeNull();
  });

  it('prefers the run’s own row to an earlier run’s', async () => {
    await calls.save(scope({ runId: 'run-c', seq: 9 }), 'key-9', 'wf-c1');
    await calls.save(scope({ runId: 'run-d', seq: 9 }), 'key-9', 'wf-d1');
    await calls.save(scope({ runId: 'run-c', seq: 9 }), 'key-9', 'wf-c2');
    expect(await calls.find(scope({ runId: 'run-d', seq: 9, carriesOn: true }), 'key-9')).toBe(
      'wf-d1'
    );
    expect(await calls.find(scope({ runId: 'run-e', seq: 9, carriesOn: true }), 'key-9')).toBe(
      'wf-c2'
    );
  });

  it('sweeps rows older than the retention, and only those', async () => {
    await calls.save(scope({ runId: 'run-old' }), 'key-old', 'wf-old');
    await calls.save(scope({ runId: 'run-new' }), 'key-new', 'wf-new');
    await pool.query(
      `update "assistant_runner".model_calls set created_at = now() - interval '8 days' where run_id = 'run-old'`
    );
    expect(await calls.sweep(7 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await calls.find(scope({ runId: 'run-old' }), 'key-old')).toBeNull();
    expect(await calls.find(scope({ runId: 'run-new' }), 'key-new')).toBe('wf-new');
  });
});
