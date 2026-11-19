import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Db from './clients/db';

// During a database primary switchover the pooler refuses or drops connections for a short window.
// These cases drive the read paths and createNotification against fake pools that fail that way first.

const h = vi.hoisted(() => ({
  /** Errors the next checkouts throw, in order; empty = checkouts succeed. */
  failures: [] as unknown[],
  /** Errors the next statements' `result()` rejects with (checkout succeeded), in order. */
  resultFailures: [] as unknown[],
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
      return {
        result: async () => {
          const resultFailure = h.resultFailures.shift();
          if (resultFailure) throw resultFailure;
          return h.rows;
        },
        cancel: async () => undefined,
      };
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
import {
  countInFlight,
  countNotifications,
  notificationExists,
  queryNotifications,
} from './operations';
import { logToAxiom } from './clients/axiom';
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
  h.resultFailures = [];
  h.statements = [];
  countInFlight.clear();
  vi.mocked(logToAxiom).mockClear();
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

describe('a connection lost during the statement is retried', () => {
  it('queryNotifications retries when result() rejects with a dropped connection', async () => {
    h.resultFailures = [new Error('Connection terminated unexpectedly')];
    h.rows = [{ id: 2 }];

    const r = await settle(queryNotifications({ userId: 5, limit: 10 }));

    expect(r).toEqual({ ok: true, value: [{ id: 2 }] });
    expect(h.statements).toHaveLength(2);
  });

  it('countNotifications retries when result() rejects with an admin shutdown', async () => {
    h.resultFailures = [adminShutdown()];
    h.rows = [{ category: 'Comment', count: '3' }];

    const r = await settle(countNotifications({ userId: 5, unread: false }));

    expect(r).toEqual({ ok: true, value: [{ category: 'Comment', count: '3' }] });
    expect(h.statements).toHaveLength(2);
  });

  it('createNotification retries the UPDATE when its result() rejects', async () => {
    // undefined = the opt-out SELECT succeeds.
    h.resultFailures = [undefined, adminShutdown()];

    const r = await settle(
      createNotification({
        key: 'c:2',
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

  it('logs one line per recovered retry, without the error message', async () => {
    h.resultFailures = [new Error('Connection terminated unexpectedly')];
    h.rows = [{ exists: 1 }];

    await settle(notificationExists('k2'));

    const lines = vi
      .mocked(logToAxiom)
      .mock.calls.map(([d]) => d as Record<string, unknown>)
      .filter((d) => d.name === 'notification.dbRetry');
    expect(lines).toEqual([
      expect.objectContaining({ type: 'info', outcome: 'recovered', retries: 1 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('Connection terminated');
  });

  it('logs one line when the retries are exhausted', async () => {
    h.failures = Array.from({ length: DB_RETRY_BACKOFF_MS.length + 1 }, adminShutdown);

    const r = await settle(notificationExists('k3'));

    expect(r.ok).toBe(false);
    const lines = vi
      .mocked(logToAxiom)
      .mock.calls.map(([d]) => d as Record<string, unknown>)
      .filter((d) => d.name === 'notification.dbRetry');
    expect(lines).toEqual([
      expect.objectContaining({
        type: 'warning',
        outcome: 'exhausted',
        retries: DB_RETRY_BACKOFF_MS.length,
        cause: { name: 'Error', code: '57P01' },
      }),
    ]);
  });

  it('logs the pooler auth failure code when the retries are exhausted on it', async () => {
    h.failures = Array.from({ length: DB_RETRY_BACKOFF_MS.length + 1 }, () =>
      pgError('28P01', 'password authentication failed for user "app"')
    );

    await settle(notificationExists('k4'));

    const lines = vi
      .mocked(logToAxiom)
      .mock.calls.map(([d]) => d as Record<string, unknown>)
      .filter((d) => d.name === 'notification.dbRetry');
    expect(lines).toEqual([
      expect.objectContaining({ outcome: 'exhausted', cause: { name: 'Error', code: '28P01' } }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('password authentication');
  });

  it('logs one line when a retry ends in an error that is not retried', async () => {
    h.failures = [adminShutdown(), pgError('42P01', 'relation "x" does not exist', 'ERROR')];

    const r = await settle(notificationExists('k5'));

    expect(r.ok).toBe(false);
    expect(h.statements).toHaveLength(2);
    const lines = vi
      .mocked(logToAxiom)
      .mock.calls.map(([d]) => d as Record<string, unknown>)
      .filter((d) => d.name === 'notification.dbRetry');
    expect(lines).toEqual([
      expect.objectContaining({
        type: 'warning',
        outcome: 'failed',
        retries: 1,
        cause: { name: 'Error', code: '42P01' },
      }),
    ]);
  });

  it('logs nothing when the first error is not retried', async () => {
    h.failures = [pgError('42P01', 'relation "x" does not exist', 'ERROR')];

    await settle(notificationExists('k6'));

    const lines = vi
      .mocked(logToAxiom)
      .mock.calls.filter(([d]) => (d as Record<string, unknown>).name === 'notification.dbRetry');
    expect(lines).toEqual([]);
  });
});

describe('createNotification survives a switchover', () => {
  it('retries the write and queues once', async () => {
    // undefined = the opt-out SELECT succeeds.
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
  const run = (errors: unknown[], random = () => 0.5) => {
    const sleeps: number[] = [];
    let calls = 0;
    const p = withDbRetry(
      async () => {
        const e = errors[calls++];
        if (e) throw e;
        return 'ok';
      },
      { sleep: async (ms) => void sleeps.push(ms), random }
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

  it('returns the value or the error unchanged when the onResult hook throws', async () => {
    const onResult = () => {
      throw new Error('hook broke');
    };
    const sleep = async () => undefined;
    let calls = 0;
    const recovered = withDbRetry(
      async () => {
        if (calls++ === 0) throw adminShutdown();
        return 'ok';
      },
      { sleep, onResult }
    );
    await expect(recovered).resolves.toBe('ok');

    const lastError = adminShutdown();
    const exhausted = withDbRetry(
      async () => {
        throw lastError;
      },
      { sleep, onResult, backoffMs: [1] }
    );
    await expect(exhausted).rejects.toBe(lastError);
  });

  it.each([
    ['a unique violation', pgError('23505', 'duplicate key value', 'ERROR')],
    ['a syntax error', pgError('42601', 'syntax error at or near "SELEC"', 'ERROR')],
    ['a pool wait timeout', new Error('timeout exceeded when trying to connect')],
    [
      "pg's connect timeout",
      markDbConnectError(new Error('Connection terminated due to connection timeout')),
    ],
    [
      "pg's connect timeout as the cause of a wrapper",
      new Error('query failed', {
        cause: new Error('Connection terminated due to connection timeout'),
      }),
    ],
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

  it('jitters each delay by up to ±50% of its base', async () => {
    const errors = Array.from({ length: DB_RETRY_BACKOFF_MS.length + 1 }, adminShutdown);
    const low = run(errors, () => 0);
    await expect(low.p).rejects.toBe(errors.at(-1));
    expect(low.sleeps).toEqual([50, 125, 250]);

    const high = run(errors, () => 0.999);
    await expect(high.p).rejects.toBe(errors.at(-1));
    expect(high.sleeps).toEqual([150, 375, 750]);
  });
});
