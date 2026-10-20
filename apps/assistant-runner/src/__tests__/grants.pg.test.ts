import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AdvisoryLock,
  OrchestrationConversationStore,
  type ConversationLock,
} from '../conversation-store';
import { startTurn, withPatch } from '../head';
import { RunGrants } from '../grants';
import { OrchestrationClient } from '../orchestration';
import { FakeOrchestration } from '../test-support/fake-orchestration';
import { freshDatabase, TEST_DATABASE_URL } from '../test-support/pg';

const describePg = TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.CI && !TEST_DATABASE_URL)
  throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set in CI');

const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

describePg('run grants and conversation locks in the runner’s database', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let pool: pg.Pool;
  let grants: RunGrants;

  beforeAll(async () => {
    db = await freshDatabase('grants');
    pool = new pg.Pool({ connectionString: db.url, max: 6 });
    grants = new RunGrants(pool);
    await grants.init();
    // The sweep reads DBOS's run statuses: launch DBOS so its schema exists.
    DBOS.setConfig({
      name: 'grants-test',
      systemDatabaseUrl: db.url,
      systemDatabaseSchemaName: 'dbos',
    });
    await DBOS.launch();
  });

  afterAll(async () => {
    await DBOS.shutdown();
    await pool?.end();
    await db?.drop();
  });

  const grant = (token: string, expiresAt: Date, userId = 'u1', conversationId = 'c1') => ({
    token,
    userId,
    conversationId,
    expiresAt,
  });

  it('hands back a run’s grant only while it is live, and a conversation’s latest live one', async () => {
    // Saved oldest first, so the answer cannot come from insertion order.
    await grants.save('run-older', grant('grant-older', hours(1)));
    await grants.save('run-live', grant('grant-live', hours(2)));
    await grants.save('run-expired', grant('grant-expired', hours(3)));
    await pool.query(
      `update assistant_runner.run_grants set expires_at = now() - interval '1 minute' where run_id = 'run-expired'`
    );
    await grants.save('run-other', grant('grant-other', hours(3), 'u2'));
    await grants.save('run-only-expired', grant('grant-only-expired', hours(-1), 'u1', 'c-stale'));

    expect(await grants.forRun('run-live')).toBe('grant-live');
    expect(await grants.forRun('run-expired')).toBeNull();
    expect(await grants.forConversation('u1', 'c1')).toBe('grant-live');
    expect(await grants.forConversation('u2', 'c1')).toBe('grant-other');
    expect(await grants.forConversation('u1', 'c2')).toBeNull();
    expect(await grants.forConversation('u1', 'c-stale')).toBeNull();
  });

  it('keeps the later of two grants saved for one run', async () => {
    await grants.save('run-retried', grant('grant-first', hours(2)));
    await grants.save('run-retried', grant('grant-earlier', hours(1)));
    expect(await grants.forRun('run-retried')).toBe('grant-first');
    await grants.save('run-retried', grant('grant-later', hours(3)));
    expect(await grants.forRun('run-retried')).toBe('grant-later');
    await grants.delete('run-retried');
    expect(await grants.forRun('run-retried')).toBeNull();
  });

  it('sweeps expired grants, those of runs that ended a while ago, and orphans; never a live run’s', async () => {
    await grants.save('sweep-expired', grant('g1', hours(-1)));
    await grants.save('sweep-ended-long-ago', grant('g2', hours(2)));
    await grants.save('sweep-ended-just-now', grant('g3', hours(2)));
    await grants.save('sweep-live', grant('g4', hours(2)));
    await grants.save('sweep-orphan', grant('g5', hours(2)));
    // Saved by a start a moment ago, before its workflow exists: not an orphan yet.
    await grants.save('sweep-just-saved', grant('g6', hours(2)));
    const now = Date.now();
    const status = (id: string, value: string, updatedAt: number) =>
      pool.query(
        `insert into dbos.workflow_status (workflow_uuid, status, name, created_at, updated_at) values ($1, $2, 'reply', $3, $3)`,
        [id, value, updatedAt]
      );
    await status('sweep-ended-long-ago', 'SUCCESS', now - 60 * 60 * 1000);
    await status('sweep-ended-just-now', 'CANCELLED', now - 1000);
    await status('sweep-live', 'PENDING', now - 60 * 60 * 1000);
    await pool.query(
      `update assistant_runner.run_grants set created_at = now() - interval '1 hour' where run_id in ('sweep-orphan', 'sweep-live')`
    );

    await grants.sweep();
    const { rows } = await pool.query<{ run_id: string }>(
      `select run_id from assistant_runner.run_grants where run_id like 'sweep-%' order by run_id`
    );
    expect(rows.map((row) => row.run_id)).toEqual([
      'sweep-ended-just-now',
      'sweep-just-saved',
      'sweep-live',
    ]);
  });

  it('serialises two writers of one conversation across connections, so neither change is lost', async () => {
    const orchestration = new FakeOrchestration();
    // Every orchestration request takes a moment, so two writers' reads overlap.
    const slowFetch: typeof fetch = async (input, init) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return orchestration.fetch(input, init);
    };
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const noLock: ConversationLock = { run: (_key, fn) => fn() };
    // Two stores, as two replicas would have, sharing only the database and orchestration.
    const replica = (lock: ConversationLock) =>
      new OrchestrationConversationStore({
        orchestration: new OrchestrationClient('https://orchestration.example', slowFetch),
        tokens: (userId) => async () => FakeOrchestration.tokenFor(userId),
        lock,
        log: quiet,
      });
    const title = { v: 1 as const, title: 'From A', titleSource: 'user' as const };
    const model = { v: 1 as const, model: 'from-b' };
    const race = async (lock: () => ConversationLock, conversationId: string) => {
      const [a, b] = [replica(lock()), replica(lock())];
      await a.update('u1', conversationId, (head) =>
        startTurn(head, {
          conversationId,
          seq: 1,
          user: { content: 'hi', attachments: [] },
          now: new Date(),
        })
      );
      await Promise.all([
        a.update('u1', conversationId, (head) =>
          head ? withPatch(head, title, new Date()) : null
        ),
        b.update('u1', conversationId, (head) =>
          head ? withPatch(head, model, new Date()) : null
        ),
      ]);
      return a.load('u1', conversationId);
    };

    // Control: without the lock the race loses one of the two changes, so this test can see it.
    const unlocked = await race(() => noLock, 'c-unlocked');
    expect(unlocked?.title === 'From A' && unlocked?.model === 'from-b').toBe(false);

    expect(await race(() => new AdvisoryLock(pool), 'c-locked')).toMatchObject({
      title: 'From A',
      model: 'from-b',
    });
  });
});
