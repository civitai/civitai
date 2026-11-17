import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Db from './clients/db';

// During a database primary switchover the pooler refuses or drops connections for a short window.
// These cases drive the read paths and createNotification against fake pools that fail that way first.

const h = vi.hoisted(() => ({
  /** Errors the next statements throw, in order; empty = statements succeed. */
  failures: [] as unknown[],
  statements: [] as string[],
  rows: [] as unknown[],
}));

vi.mock('./clients/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  const pool = {
    cancellableQuery: async (sql: string) => {
      h.statements.push(sql);
      const failure = h.failures.shift();
      if (failure) throw failure;
      return { result: async () => h.rows, cancel: async () => undefined };
    },
  };
  return { ...actual, notifDbWrite: () => pool, notifDbRead: () => pool, mainDbRead: () => pool };
});
vi.mock('./lag', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNotifDbWithoutLag: async () => (await import('./clients/db')).notifDbRead(),
}));
vi.mock('./clients/axiom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logToAxiom: vi.fn(async () => undefined),
}));

import { markDbConnectError } from '@civitai/db';
import { createNotification } from './create';
import { notificationExists, queryNotifications } from './operations';
import { DB_RETRY_BACKOFF_MS, withDbRetry } from './db-retry';

const pgError = (code: string, message: string, severity = 'FATAL') =>
  Object.assign(new Error(message), { code, severity });

const adminShutdown = () => pgError('57P01', 'terminating connection due to administrator command');

/** Runs `p` to completion while advancing fake time, and reports how it settled. */
async function settle<T>(p: Promise<T>) {
  const out = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await vi.advanceTimersByTimeAsync(5_000);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.failures = [];
  h.statements = [];
  h.rows = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('read paths survive a switchover', () => {
  it('notificationExists retries a dropped connection and answers', async () => {
    h.failures = [adminShutdown()];
    h.rows = [{ exists: 1 }];

    const r = await settle(notificationExists('k1'));

    expect(r).toEqual({ ok: true, value: true });
    expect(h.statements).toHaveLength(2);
  });

  it('queryNotifications retries until the connection comes back', async () => {
    h.failures = [
      pgError(
        '08P01',
        'server login has been failing, try again later (server_login_retry)',
        'ERROR'
      ),
      pgError('28P01', 'password authentication failed for user "app"'),
    ];
    h.rows = [{ id: 1 }];

    const r = await settle(queryNotifications({ userId: 5, limit: 10 }));

    expect(r).toEqual({ ok: true, value: [{ id: 1 }] });
    expect(h.statements).toHaveLength(3);
  });
});

describe('createNotification survives a switchover', () => {
  it('retries the write and queues once', async () => {
    // Opt-out lookup succeeds, the UPDATE's connection drops once, the retried UPDATE finds no row and
    // the INSERT runs.
    h.failures = [undefined, new Error('Connection terminated unexpectedly')];

    const r = await settle(
      createNotification({
        key: 'c:1',
        type: 'comment',
        category: 'Comment',
        details: {},
        userId: 7,
      })
    );

    expect(r).toEqual({ ok: true, value: { queued: 1 } });
    const kinds = h.statements.map((s) => s.trim().split(/\s/)[0]);
    expect(kinds).toEqual(['SELECT', 'UPDATE', 'UPDATE', 'INSERT']);
  });

  it('does not retry a constraint violation', async () => {
    const violation = pgError('23505', 'duplicate key value violates unique constraint', 'ERROR');
    h.failures = [undefined, violation];

    const r = await settle(
      createNotification({
        key: 'c:1',
        type: 'comment',
        category: 'Comment',
        details: {},
        userId: 7,
      })
    );

    expect(r).toEqual({ ok: false, error: violation });
    expect(h.statements).toHaveLength(2);
  });
});

describe('withDbRetry', () => {
  const run = (errors: unknown[]) => {
    const sleeps: number[] = [];
    let calls = 0;
    const p = withDbRetry(
      async () => {
        const e = errors[calls++];
        if (e) throw e;
        return 'ok';
      },
      { sleep: async (ms) => void sleeps.push(ms) }
    );
    return { p, sleeps, calls: () => calls };
  };

  it.each([
    ['admin shutdown (57P01)', adminShutdown()],
    ['connection failure (08006)', pgError('08006', 'connection failure')],
    ['cannot connect now (57P03)', pgError('57P03', 'the database system is starting up')],
    ['auth failure (28P01)', pgError('28P01', 'password authentication failed')],
    ['connection terminated', new Error('Connection terminated unexpectedly')],
    [
      'refused while connecting',
      markDbConnectError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      ),
    ],
  ])('retries %s', async (_name, error) => {
    const r = run([error]);
    await expect(r.p).resolves.toBe('ok');
    expect(r.calls()).toBe(2);
  });

  it.each([
    ['a unique violation', pgError('23505', 'duplicate key value', 'ERROR')],
    ['a syntax error', pgError('42601', 'syntax error at or near "SELEC"', 'ERROR')],
    ['a pool wait timeout', new Error('timeout exceeded when trying to connect')],
    ['an auth code without a server severity', Object.assign(new Error('x'), { code: '28P01' })],
    ['a plain error', new Error('boom')],
  ])('does not retry %s', async (_name, error) => {
    const r = run([error]);
    await expect(r.p).rejects.toBe(error);
    expect(r.calls()).toBe(1);
  });

  it('throws the last connection error once the backoff is used up', async () => {
    const errors = Array.from({ length: DB_RETRY_BACKOFF_MS.length + 1 }, adminShutdown);
    const r = run(errors);

    await expect(r.p).rejects.toBe(errors.at(-1));
    expect(r.calls()).toBe(DB_RETRY_BACKOFF_MS.length + 1);
    expect(r.sleeps).toEqual([100, 250, 500]);
  });
});
