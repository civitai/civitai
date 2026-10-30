import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrchestrationConversationStore } from '../conversation-store';
import { AdvisoryLock, type ConversationLock } from '../core/advisory-lock';
import { startTurn, withPatch } from '../core/head';
import { RunGrants } from '../grants';
import { OrchestrationClient } from '../orchestration';
import { FakeOrchestration } from '../test-support/fake-orchestration';
import { freshDatabase, TEST_DATABASE_URL } from '../core/test-support/pg';

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

  it('sweeps expired grants only, never a live one whatever its run did', async () => {
    await grants.save('sweep-expired', grant('g1', hours(-1)));
    await grants.save('sweep-ended-long-ago', grant('g2', hours(2)));
    await grants.save('sweep-just-saved', grant('g3', hours(2)));
    // A run that ended an hour ago, as DBOS records it: the runner deletes its grant on the end path
    // itself, so the sweep has no reason to read DBOS's tables.
    await pool.query(
      `insert into dbos.workflow_status (workflow_uuid, status, name, created_at, updated_at) values ('sweep-ended-long-ago', 'SUCCESS', 'reply', $1, $1)`,
      [Date.now() - 60 * 60 * 1000]
    );
    await grants.sweep();
    const { rows } = await pool.query<{ run_id: string }>(
      `select run_id from assistant_runner.run_grants where run_id like 'sweep-%' order by run_id`
    );
    expect(rows.map((row) => row.run_id)).toEqual(['sweep-ended-long-ago', 'sweep-just-saved']);
  });

  it('keeps a grant with an end still to save, and lists that end while the grant is live', async () => {
    const reply = { messages: [], status: 'done' as const };
    await grants.save('pending-live', grant('gp1', hours(2), 'u-pending', 'c-pending'));
    await grants.save('pending-expired', grant('gp2', hours(-1), 'u-pending', 'c-pending'));
    await grants.save('not-pending', grant('gp3', hours(2), 'u-pending', 'c-pending'));
    await grants.markEndPending('pending-live', 3, reply);
    await grants.markEndPending('pending-expired', 4, reply);

    await grants.forgetUnlessEndPending('pending-live');
    await grants.forgetUnlessEndPending('not-pending');
    expect(await grants.forRun('pending-live')).toBe('gp1');
    expect(await grants.forRun('not-pending')).toBeNull();
    expect(await grants.pendingEnds()).toEqual([
      { runId: 'pending-live', userId: 'u-pending', conversationId: 'c-pending', seq: 3, reply },
    ]);
  });

  it('says so, by run id, when the sweep drops a grant whose end was never saved', async () => {
    const warnings: { object: object; message?: string }[] = [];
    const logged = new RunGrants(pool, {
      warn: (object, message) => warnings.push({ object, message }),
    });
    await logged.save('lost-end', grant('g-lost', hours(-1), 'u-lost', 'c-lost'));
    await logged.markEndPending('lost-end', 1, { messages: [], status: 'done' });
    await logged.save('plain-expired', grant('g-plain', hours(-1), 'u-lost', 'c-lost'));
    await logged.sweep();
    // Rows earlier tests left expired may be swept here too: judge this test's two rows only.
    const mine = warnings.filter(({ object }) =>
      ['lost-end', 'plain-expired'].includes((object as { runId?: string }).runId ?? '')
    );
    expect(mine).toEqual([{ object: { runId: 'lost-end' }, message: expect.any(String) }]);
    expect(JSON.stringify(warnings)).not.toContain('g-lost');
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
