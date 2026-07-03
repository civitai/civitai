import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral coverage for the fan-out worker (closes G1 from the 2026-07-03 coverage audit). The sibling
// poll-loop.test.ts only asserts the PENDING_CLAIM_QUERY *string*; this suite exercises the actual fan-out
// LOGIC — handleNormal / handleDebounce / create / run — against a fake PoolClient that records the SQL it
// is handed and returns canned rows. Same "fake pool records SQL" idiom as operations.test.ts, extended to
// drive control flow (branches, retries, txn wrapper) rather than only inspect the emitted string.

// ---- Shared, hoisted mock state (vi.mock factories are hoisted above imports; see operations.test.ts) ---
const h = vi.hoisted(() => {
  const state: {
    connectClient: any;
    connectError: Error | null;
    pendingRows: any[];
  } = { connectClient: null, connectError: null, pendingRows: [] };
  return { state };
});

vi.mock('../lib/server/clients/db', () => ({
  // notifDbWrite() serves BOTH the checked-out client (create → connect()) and the batch-claim
  // (getPending → cancellableQuery()). Pool saturation gauge fields are present so startWorker is importable.
  notifDbWrite: () => ({
    connect: async () => {
      if (h.state.connectError) throw h.state.connectError;
      return h.state.connectClient;
    },
    cancellableQuery: async (_sql: string) => ({ result: async () => h.state.pendingRows }),
    totalCount: 0,
    idleCount: 0,
  }),
  notifDbRead: () => ({}),
  mainDbRead: () => ({}),
}));

vi.mock('../lib/server/clients/axiom', () => ({
  logToAxiom: vi.fn(async () => {}),
  logAxiomError: vi.fn(() => {}),
  safeError: (e: unknown) => ({ message: String(e) }),
}));

vi.mock('../lib/server/cache', () => ({
  notificationCache: {
    incrementUser: vi.fn(async () => {}),
    decrementUser: vi.fn(async () => {}),
    getUser: vi.fn(async () => undefined),
    setUser: vi.fn(async () => {}),
    bustUser: vi.fn(async () => {}),
    clearCategory: vi.fn(async () => {}),
  },
}));

vi.mock('../lib/server/metrics', () => ({
  notificationsFannedOutTotal: { inc: vi.fn() },
  signalsDeliveryTotal: { inc: vi.fn() },
  workerPendingProcessedTotal: { inc: vi.fn() },
  workerTickSeconds: { startTimer: () => () => {} },
  writePoolActive: { set: vi.fn() },
}));

vi.mock('../env', () => ({ signalsEndpoint: 'http://signals.test' }));

import { create, handleDebounce, handleNormal, run } from './poll-loop';
import { notificationCache } from '../lib/server/cache';
import {
  notificationsFannedOutTotal,
  workerPendingProcessedTotal,
} from '../lib/server/metrics';

// ---- Fake PoolClient -------------------------------------------------------------------------------------
// query(sql) dispatches on the SQL shape and returns a per-key canned response. A response is either
// `{ rows }` or `{ throw: err }`; a key's value may be a single response (reused) or an array consumed in
// call order (so the 23505 retry can be `[<empty select>, <select returns id>]`).
type Resp = { rows?: any[]; throw?: any };
type Responses = Partial<Record<
  'notifSelect' | 'notifUpdate' | 'notifInsert' | 'userInsert' | 'pendingDelete' | 'pendingUpdate',
  Resp | Resp[]
>>;

function keyFor(sql: string): keyof Responses | 'txn' | null {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return 'txn';
  if (sql.includes('SELECT id FROM "Notification"')) return 'notifSelect';
  if (sql.includes('UPDATE "Notification" SET')) return 'notifUpdate';
  if (sql.includes('INSERT INTO "Notification"')) return 'notifInsert';
  if (sql.includes('INSERT INTO "UserNotification"')) return 'userInsert';
  if (sql.includes('DELETE FROM "PendingNotification"')) return 'pendingDelete';
  if (sql.includes('UPDATE "PendingNotification"')) return 'pendingUpdate';
  return null;
}

function makeClient(responses: Responses = {}) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    const key = keyFor(sql);
    if (key === 'txn' || key === null) return { rows: [] };
    const spec = responses[key];
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    let resp: Resp | undefined;
    if (Array.isArray(spec)) resp = spec[Math.min(i, spec.length - 1)];
    else resp = spec;
    if (resp?.throw) throw resp.throw;
    return { rows: resp?.rows ?? [] };
  });
  const on = vi.fn();
  const removeListener = vi.fn();
  const release = vi.fn();
  const client: any = { query, on, removeListener, release };
  // Convenience accessors for assertions.
  client.calls = calls;
  client.keys = () => calls.map(keyFor);
  return client;
}

const baseRow = {
  id: 7,
  type: 'comment',
  category: 'Comment' as const,
  key: 'comment:1',
  users: [11, 22],
  details: { foo: 'bar' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.connectClient = null;
  h.state.connectError = null;
  h.state.pendingRows = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as any));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =========================================================================================================
describe('handleNormal', () => {
  it('reuses the existing Notification.id (SELECT hit) and does NOT INSERT a Notification', async () => {
    const client = makeClient({
      notifSelect: { rows: [{ id: 500 }] },
      userInsert: { rows: [{ id: 1, userId: 11, createdAt: 'x' }] },
    });
    const ret = await handleNormal({ ...baseRow, debounceSeconds: null } as any, client);

    expect(client.keys()).toEqual(['notifSelect', 'userInsert', 'pendingDelete']);
    // No Notification INSERT when the key already exists (avoids burning a sequence value).
    expect(client.calls.some((s: string) => keyFor(s) === 'notifInsert')).toBe(false);
    expect(ret).toEqual([{ id: 1, userId: 11, createdAt: 'x' }]);
  });

  it('INSERTs a Notification when the key is new, then fans out and deletes the pending row', async () => {
    const client = makeClient({
      notifSelect: { rows: [] },
      notifInsert: { rows: [{ id: 900 }] },
      userInsert: { rows: [{ id: 2, userId: 22, createdAt: 'y' }] },
    });
    const ret = await handleNormal({ ...baseRow, debounceSeconds: null } as any, client);

    expect(client.keys()).toEqual(['notifSelect', 'notifInsert', 'userInsert', 'pendingDelete']);
    // The Notification.id from the INSERT must reach the UserNotification fan-out (pg-format quotes it).
    const userSql = client.calls.find((s: string) => keyFor(s) === 'userInsert')!;
    expect(userSql).toContain("'900'");
    expect(ret).toEqual([{ id: 2, userId: 22, createdAt: 'y' }]);
  });

  it('fans out with ON CONFLICT DO NOTHING (dedup, no viewed reset) and deletes the pending row', async () => {
    const client = makeClient({ notifSelect: { rows: [{ id: 1 }] }, userInsert: { rows: [] } });
    await handleNormal({ ...baseRow, debounceSeconds: null } as any, client);

    const userSql = client.calls.find((s: string) => keyFor(s) === 'userInsert')!;
    expect(userSql).toContain('ON CONFLICT DO NOTHING');
    // The normal (non-debounce) path must NOT resurrect read notifications.
    expect(userSql).not.toContain('viewed = FALSE');
    expect(client.calls.some((s: string) => keyFor(s) === 'pendingDelete')).toBe(true);
  });

  it('recovers from a 23505 unique-violation on INSERT by re-SELECTing the key', async () => {
    const client = makeClient({
      // 1st SELECT empty → INSERT races (23505) → 2nd SELECT returns the row the other writer created.
      notifSelect: [{ rows: [] }, { rows: [{ id: 777 }] }],
      notifInsert: { throw: { code: '23505' } },
      userInsert: { rows: [{ id: 3, userId: 11, createdAt: 'z' }] },
    });
    const ret = await handleNormal({ ...baseRow, debounceSeconds: null } as any, client);

    // SELECT, INSERT(throws), SELECT(retry), then fan-out on the recovered id.
    expect(client.keys()).toEqual(['notifSelect', 'notifInsert', 'notifSelect', 'userInsert', 'pendingDelete']);
    const userSql = client.calls.find((s: string) => keyFor(s) === 'userInsert')!;
    expect(userSql).toContain("'777'"); // recovered id from the re-SELECT reaches fan-out
    expect(ret).toEqual([{ id: 3, userId: 11, createdAt: 'z' }]);
  });

  it('rethrows a non-23505 INSERT error (does NOT swallow / retry)', async () => {
    const client = makeClient({
      notifSelect: { rows: [] },
      notifInsert: { throw: { code: '23502' } }, // not_null_violation — a real bug, must surface
    });
    await expect(handleNormal({ ...baseRow, debounceSeconds: null } as any, client)).rejects.toEqual({
      code: '23502',
    });
    // No re-SELECT, no fan-out, no delete after a hard failure.
    expect(client.keys()).toEqual(['notifSelect', 'notifInsert']);
  });

  it('batches the UserNotification fan-out and concatenates every batch into retData', async () => {
    // 2 users, default insertBatchSize (5000) → single batch; assert both fanned rows returned.
    const client = makeClient({
      notifSelect: { rows: [{ id: 1 }] },
      userInsert: { rows: [{ id: 10, userId: 11, createdAt: 'a' }, { id: 11, userId: 22, createdAt: 'b' }] },
    });
    const ret = await handleNormal({ ...baseRow, debounceSeconds: null } as any, client);
    expect(ret).toHaveLength(2);
    const userSql = client.calls.find((s: string) => keyFor(s) === 'userInsert')!;
    // Both user ids present in the VALUES tuple list.
    expect(userSql).toContain('11');
    expect(userSql).toContain('22');
  });
});

// =========================================================================================================
describe('handleDebounce', () => {
  // Drop when lastTriggered + debounceSeconds < nextSendAt (the window has not elapsed yet).
  const dropRow = {
    ...baseRow,
    debounceSeconds: 60,
    lastTriggered: '2026-01-01T00:00:00.000Z',
    nextSendAt: '2026-01-01T00:05:00.000Z', // +5min > +60s → isBefore === true → DROP
  };
  // Fan out when lastTriggered + debounceSeconds >= nextSendAt (window elapsed).
  const fanoutRow = {
    ...baseRow,
    debounceSeconds: 60,
    lastTriggered: '2026-01-01T00:05:00.000Z',
    nextSendAt: '2026-01-01T00:05:30.000Z', // +60s == 00:06:00 not before 00:05:30 → FAN OUT
  };

  it('DROP path: deletes the pending row and fans out NOTHING when the debounce window is open', async () => {
    const client = makeClient({});
    const ret = await handleDebounce(dropRow as any, client);

    expect(ret).toEqual([]);
    expect(client.keys()).toEqual(['pendingDelete']);
    // Critically: no Notification touch, no UserNotification insert, no reschedule.
    expect(client.calls.some((s: string) => keyFor(s) === 'userInsert')).toBe(false);
    expect(client.calls.some((s: string) => keyFor(s) === 'pendingUpdate')).toBe(false);
  });

  it('FAN-OUT path: UPDATEs the notification, fans out, and RESCHEDULES the pending row', async () => {
    const client = makeClient({
      notifUpdate: { rows: [{ id: 42 }] },
      userInsert: { rows: [{ id: 1, userId: 11, createdAt: 'c' }] },
    });
    const ret = await handleDebounce(fanoutRow as any, client);

    // UPDATE-first (no INSERT since UPDATE returned an id), fan-out, then reschedule (NOT delete).
    expect(client.keys()).toEqual(['notifUpdate', 'userInsert', 'pendingUpdate']);
    expect(client.calls.some((s: string) => keyFor(s) === 'notifInsert')).toBe(false);
    expect(client.calls.some((s: string) => keyFor(s) === 'pendingDelete')).toBe(false);
    // Reschedule clears the claim and pushes nextSendAt out by debounceSeconds.
    const rescheduleSql = client.calls.find((s: string) => keyFor(s) === 'pendingUpdate')!;
    expect(rescheduleSql).toContain('"claimedAt" = null');
    expect(rescheduleSql).toContain(`"debounceSeconds", ' seconds'`);
    expect(ret).toEqual([{ id: 1, userId: 11, createdAt: 'c' }]);
  });

  it('FAN-OUT path: INSERT ON CONFLICT DO UPDATE when the notification key is new (UPDATE hits 0 rows)', async () => {
    const client = makeClient({
      notifUpdate: { rows: [] }, // key does not exist yet → UPDATE affects nothing → INSERT-upsert
      notifInsert: { rows: [{ id: 88 }] },
      userInsert: { rows: [{ id: 1, userId: 11, createdAt: 'c' }] },
    });
    await handleDebounce(fanoutRow as any, client);

    expect(client.keys()).toEqual(['notifUpdate', 'notifInsert', 'userInsert', 'pendingUpdate']);
    const insertSql = client.calls.find((s: string) => keyFor(s) === 'notifInsert')!;
    expect(insertSql).toContain('ON CONFLICT ("key") DO UPDATE');
  });

  it('FAN-OUT path: resurrects read notifications via ON CONFLICT DO UPDATE ... viewed = FALSE', async () => {
    const client = makeClient({ notifUpdate: { rows: [{ id: 42 }] }, userInsert: { rows: [] } });
    await handleDebounce(fanoutRow as any, client);

    const userSql = client.calls.find((s: string) => keyFor(s) === 'userInsert')!;
    // The debounce path (unlike handleNormal) MUST re-surface an already-read notification.
    expect(userSql).toContain('ON CONFLICT ("notificationId", "userId") DO UPDATE');
    expect(userSql).toContain('viewed = FALSE');
    expect(userSql).toContain('"createdAt" = now()');
  });

  it('DROP decision is exact at the boundary: fires the DELETE, not the reschedule', async () => {
    // Boundary sanity: lastTriggered + debounce strictly before nextSendAt.
    const client = makeClient({});
    await handleDebounce(
      {
        ...baseRow,
        debounceSeconds: 30,
        lastTriggered: '2026-01-01T00:00:00.000Z',
        nextSendAt: '2026-01-01T00:00:31.000Z', // +30s = 00:00:30 < 00:00:31 → DROP
      } as any,
      client
    );
    expect(client.keys()).toEqual(['pendingDelete']);
  });
});

// =========================================================================================================
describe('create (transaction wrapper)', () => {
  it('BEGIN → handler → COMMIT on the happy path and returns the fanned rows', async () => {
    const client = makeClient({
      notifSelect: { rows: [{ id: 1 }] },
      userInsert: { rows: [{ id: 9, userId: 11, createdAt: 'q' }] },
    });
    h.state.connectClient = client;

    const ret = await create({ ...baseRow, debounceSeconds: null } as any);

    expect(client.calls[0]).toBe('BEGIN');
    expect(client.calls).toContain('COMMIT');
    expect(client.calls).not.toContain('ROLLBACK');
    expect(ret).toEqual([{ id: 9, userId: 11, createdAt: 'q' }]);
  });

  it('routes debounced rows to handleDebounce (reschedule, not delete)', async () => {
    const client = makeClient({ notifUpdate: { rows: [{ id: 1 }] }, userInsert: { rows: [] } });
    h.state.connectClient = client;

    await create({
      ...baseRow,
      debounceSeconds: 60,
      lastTriggered: '2026-01-01T00:05:00.000Z',
      nextSendAt: '2026-01-01T00:05:30.000Z',
    } as any);

    // handleDebounce fingerprint: an UPDATE "Notification" and a reschedule UPDATE "PendingNotification".
    expect(client.calls.some((s: string) => keyFor(s) === 'notifUpdate')).toBe(true);
    expect(client.calls.some((s: string) => keyFor(s) === 'pendingUpdate')).toBe(true);
  });

  it('ROLLBACK and returns undefined when a handler throws (never leaks the error)', async () => {
    const client = makeClient({
      notifSelect: { rows: [] },
      notifInsert: { throw: { code: '23502' } }, // non-retryable → handleNormal throws
    });
    h.state.connectClient = client;

    const ret = await create({ ...baseRow, debounceSeconds: null } as any);

    expect(ret).toBeUndefined();
    expect(client.calls).toContain('ROLLBACK');
    expect(client.calls).not.toContain('COMMIT');
  });

  it('attaches an error listener to the checked-out client and removes it before release', async () => {
    const client = makeClient({ notifSelect: { rows: [{ id: 1 }] }, userInsert: { rows: [] } });
    h.state.connectClient = client;

    await create({ ...baseRow, debounceSeconds: null } as any);

    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    const attached = client.on.mock.calls[0][1];
    // The SAME listener must be removed (else it accumulates one-per-call on the reused connection).
    expect(client.removeListener).toHaveBeenCalledWith('error', attached);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('still removes the listener and releases the client on the throw path', async () => {
    const client = makeClient({
      notifSelect: { rows: [] },
      notifInsert: { throw: { code: '23502' } },
    });
    h.state.connectClient = client;

    await create({ ...baseRow, debounceSeconds: null } as any);

    const attached = client.on.mock.calls[0][1];
    expect(client.removeListener).toHaveBeenCalledWith('error', attached);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================================================
describe('run (poll pass)', () => {
  it('counts an errored outcome and skips fan-out when create returns undefined', async () => {
    // A handler error inside the txn → create() ROLLBACKs and returns undefined (the only path to
    // undefined; connect() throwing would propagate out of create, so it must fail mid-transaction).
    const client = makeClient({ notifSelect: { rows: [] }, notifInsert: { throw: { code: '23502' } } });
    h.state.connectClient = client;
    h.state.pendingRows = [{ ...baseRow, debounceSeconds: null }];

    await run();

    expect(workerPendingProcessedTotal.inc).toHaveBeenCalledWith({ outcome: 'errored' });
    expect(workerPendingProcessedTotal.inc).not.toHaveBeenCalledWith({ outcome: 'fanned' });
    // No fan-out side effects for a failed row.
    expect(notificationsFannedOutTotal.inc).not.toHaveBeenCalled();
    expect(notificationCache.incrementUser).not.toHaveBeenCalled();
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
  });

  it('fans out: increments the per-user cache and POSTs a realtime signal per affected user', async () => {
    const client = makeClient({
      notifSelect: { rows: [{ id: 1 }] },
      userInsert: { rows: [{ id: 9, userId: 11, createdAt: 'q' }] },
    });
    h.state.connectClient = client;
    h.state.pendingRows = [{ ...baseRow, users: [11], debounceSeconds: null }];

    await run();

    expect(workerPendingProcessedTotal.inc).toHaveBeenCalledWith({ outcome: 'fanned' });
    expect(notificationsFannedOutTotal.inc).toHaveBeenCalledWith(1);
    expect(notificationCache.incrementUser).toHaveBeenCalledWith(11, 'Comment');
    // Fire-and-forget signal POST to the affected user.
    const fetchMock = globalThis.fetch as any;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('http://signals.test/users/11/signals/');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ type: 'comment', category: 'Comment', id: 9, read: false });
  });

  it('does no work when there are no pending rows', async () => {
    h.state.pendingRows = [];
    await run();
    expect(workerPendingProcessedTotal.inc).not.toHaveBeenCalled();
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
  });
});
