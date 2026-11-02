import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import type * as Db from './clients/db';

// The notices route against real SQL: the notification DB is PGlite loaded with the same docker-init
// DDL as the local container (01 + 02), and the main DB is a two-table PGlite fixture. Only the pools
// are swapped; the route, gate, bucketing and createNotificationsBulk run unmodified.

const PRODUCER_TOKEN = 'producer-token-aaaaaaaa';
const NOTICES_TOKEN = 'notices-token-bbbbbbbbbb';
const CEILING = 10;

const h = vi.hoisted(() => ({
  notif: undefined as unknown as PGlite,
  main: undefined as unknown as PGlite,
  failOn: undefined as string | undefined,
  beforePendingInsert: undefined as undefined | (() => Promise<void>),
  failPendingInsertAfter: Infinity,
  pendingInserts: 0,
}));

vi.mock('./clients/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  const run = async (db: () => PGlite, sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO "PendingNotification"')) {
      const hook = h.beforePendingInsert;
      h.beforePendingInsert = undefined;
      await hook?.();
      if (h.pendingInserts >= h.failPendingInsertAfter) throw new Error('insert boom');
      h.pendingInserts++;
    }
    if (h.failOn && sql.includes(h.failOn)) throw new Error('audit boom');
    const { rows } = await db().query(sql, params as unknown[]);
    // Transaction-mode pooler: the next statement may run on another server connection, so no
    // session state (advisory locks, SET, temp tables) survives from one statement to the next.
    await db().exec('DISCARD ALL');
    return rows;
  };
  const pool = (db: () => PGlite) => ({
    cancellableQuery: async (sql: string, params?: unknown[]) => ({
      result: () => run(db, sql, params),
      cancel: async () => undefined,
    }),
  });
  return {
    ...actual,
    notifDbWrite: () => pool(() => h.notif),
    notifDbRead: () => pool(() => h.notif),
    mainDbRead: () => pool(() => h.main),
  };
});

const ddlDir = fileURLToPath(
  new URL('../../../../../containers/notification-db/docker-init/', import.meta.url)
);
const notifDdl = ['01_all_ddl.sql', '02_notice_send.sql']
  .map((f) => readFileSync(ddlDir + f, 'utf8').replaceAll('CONCURRENTLY', ''))
  .join('\n');

// 1-8 active; 5 opted out of system-message; 20 banned; 21 deleted; 999 does not exist.
async function createDbs() {
  h.notif = new PGlite();
  await h.notif.exec(notifDdl);
  h.main = new PGlite();
  await h.main.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
    CREATE TABLE "UserNotificationSettings" (id serial PRIMARY KEY, "userId" int NOT NULL, type text NOT NULL);
    INSERT INTO "User" (id) SELECT generate_series(1, 8);
    INSERT INTO "User" (id, "bannedAt") VALUES (20, now());
    INSERT INTO "User" (id, "deletedAt") VALUES (21, now());
    INSERT INTO "UserNotificationSettings" ("userId", type) VALUES (5, 'system-message');
  `);
}

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv('NOTIFICATIONS_TOKEN', PRODUCER_TOKEN);
  vi.stubEnv('NOTIFICATIONS_NOTICES_TOKEN', NOTICES_TOKEN);
  vi.stubEnv('NOTICES_DAILY_RECIPIENT_CEILING', String(CEILING));
  vi.stubEnv('NOTICES_CHUNK_PAUSE_MS', '0');
  await createDbs();
  const { buildServer } = await import('../../app');
  app = await buildServer();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  h.failOn = undefined;
  h.beforePendingInsert = undefined;
  h.failPendingInsertAfter = Infinity;
  h.pendingInserts = 0;
  await h.notif.exec(`
    TRUNCATE "PendingNotification", "UserNotification", "Notification", "NoticeSendCall", "NoticeSend",
      "NoticeSendLease"
    RESTART IDENTITY CASCADE;
  `);
});

const base = {
  sendId: 'test-send-1',
  type: 'system-message',
  message: 'Hello there',
  url: '/user/buzz-dashboard',
  sentBy: 'test',
  reason: 'hq:test',
};

function post(body: unknown, { url = '/notifications/notices', token = NOTICES_TOKEN } = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object,
  });
}

async function pending() {
  return (
    await h.notif.query<{
      key: string;
      users: number[];
      details: { message: string; url?: string };
      dedupeKey: string;
      category: string;
    }>(`SELECT key, users, details, "dedupeKey", category FROM "PendingNotification" ORDER BY key`)
  ).rows;
}

async function holdLease(name: string, until: string) {
  await h.notif.query(
    `INSERT INTO "NoticeSendLease" (name, holder, "lockedUntil") VALUES ($1, 'another-call', now() + $2::interval)`,
    [name, until]
  );
}

async function leases() {
  const r = await h.notif.query<{ n: number }>(`SELECT count(*)::int AS n FROM "NoticeSendLease"`);
  return r.rows[0].n;
}

describe('dry run', () => {
  it('is the default, writes no queue rows, and reports buckets and rendered samples', async () => {
    const res = await post({ ...base, userIds: [1, 2, 5, 20, 21, 999] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('dry-run');
    expect(body.requested).toBe(6);
    expect(body.counts).toEqual({
      queued: 2,
      optedOut: 1,
      unknownUser: 1,
      inactiveUser: 2,
      alreadySent: 0,
    });
    expect(body.dropped).toEqual({ optedOut: [5], unknownUser: [999], inactiveUser: [20, 21] });
    expect(body.samples[0]).toEqual({
      userId: 1,
      message: 'Hello there',
      url: '/user/buzz-dashboard',
    });
    expect(await pending()).toEqual([]);
  });

  it('includeInactive keeps banned and deleted users', async () => {
    const res = await post({ ...base, userIds: [1, 20, 21], includeInactive: true });
    expect(res.json().counts).toMatchObject({ queued: 3, inactiveUser: 0 });
  });
});

describe('send', () => {
  it('queues one row for plain userIds, tagged with the send dedupeKey', async () => {
    const res = await post({ ...base, mode: 'send', userIds: [1, 2, 5] });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.queued).toBe(2);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'notice:test-send-1',
      dedupeKey: 'notice:test-send-1',
      category: 'Other',
      details: { message: 'Hello there', url: '/user/buzz-dashboard' },
    });
    expect([...rows[0].users].sort()).toEqual([1, 2]);
  });

  it('takes the category from the type, never the caller', async () => {
    await post({
      ...base,
      type: 'system-announcement',
      mode: 'send',
      userIds: [1],
      category: 'Other',
    });
    expect((await pending())[0].category).toBe('System');
  });

  it('queues one per-user row with rendered text when params are used', async () => {
    const res = await post({
      ...base,
      mode: 'send',
      message: 'Refunded {amount} Buzz',
      recipients: [
        { userId: 1, params: { amount: '10' } },
        { userId: 2, params: { amount: '22,683' } },
      ],
    });
    expect(res.statusCode).toBe(200);
    const rows = await pending();
    expect(rows.map((r) => [r.key, r.users, r.dedupeKey, r.details.message])).toEqual([
      ['notice:test-send-1:1', [1], 'notice:test-send-1', 'Refunded 10 Buzz'],
      ['notice:test-send-1:2', [2], 'notice:test-send-1', 'Refunded 22,683 Buzz'],
    ]);
  });
});

describe('idempotency', () => {
  it('a re-send queues nothing and counts everyone as alreadySent', async () => {
    await post({ ...base, mode: 'send', userIds: [1, 2] });
    const before = await pending();
    const again = await post({ ...base, mode: 'send', userIds: [1, 2, 3] });
    expect(again.statusCode).toBe(200);
    expect(again.json().counts).toMatchObject({ queued: 1, alreadySent: 2 });
    const dry = await post({ ...base, userIds: [1, 2, 3] });
    expect(dry.json().counts).toMatchObject({ queued: 0, alreadySent: 3 });
    expect((await pending())[0].users.length).toBe(before[0].users.length + 1);
  });

  describe('through the fan-out worker', () => {
    const teamNotice = {
      ...base,
      type: 'system-announcement',
      message: 'Team {team}',
      mode: 'send',
      recipients: [{ userId: 1, params: { team: 'Pink' } }],
    };

    // The worker's own per-row handler, run against the same PGlite (whose query() returns { rows }
    // like a pg client) for every queued row.
    async function fanOut() {
      const { handleNormal } = await import('../../worker/poll-loop');
      const rows = (await h.notif.query(`SELECT * FROM "PendingNotification" ORDER BY id`)).rows;
      for (const row of rows) await handleNormal(row as never, h.notif as never);
      return rows;
    }
    async function userNotifications() {
      return (
        await h.notif.query<{ userId: number; viewed: boolean }>(
          `SELECT "userId", viewed FROM "UserNotification" ORDER BY id`
        )
      ).rows;
    }

    it('a second send after delivery leaves one UserNotification, still read', async () => {
      expect((await post(teamNotice)).json().counts).toMatchObject({ queued: 1 });
      await fanOut();
      await h.notif.exec(`UPDATE "UserNotification" SET viewed = true`);

      expect((await post(teamNotice)).json().counts).toMatchObject({ queued: 0, alreadySent: 1 });
      await fanOut();

      expect(await userNotifications()).toEqual([{ userId: 1, viewed: true }]);
    });

    it('the worker replaying the same queued row adds no second row and keeps it read', async () => {
      await post(teamNotice);
      const [row] = await fanOut();
      await h.notif.exec(`UPDATE "UserNotification" SET viewed = true`);

      const { handleNormal } = await import('../../worker/poll-loop');
      await handleNormal(row as never, h.notif as never);

      expect(await userNotifications()).toEqual([{ userId: 1, viewed: true }]);
    });
  });

  it('counts a delivered UserNotification carrying the dedupeKey as alreadySent', async () => {
    await h.notif.exec(`
      INSERT INTO "Notification" (id, type, key, category, details)
        VALUES (1, 'system-message', 'notice:test-send-1', 'Other', '{}');
      INSERT INTO "UserNotification" ("notificationId", "userId", "dedupeKey")
        VALUES (1, 4, 'notice:test-send-1');
    `);
    const res = await post({ ...base, userIds: [3, 4] });
    expect(res.json().counts).toMatchObject({ queued: 1, alreadySent: 1 });
    expect(res.json().dropped.alreadySent).toEqual([4]);
  });

  it('counts a per-user Notification the worker has inserted but not yet fanned out', async () => {
    await h.notif.exec(`
      INSERT INTO "Notification" (id, type, key, category, details)
        VALUES (1, 'system-message', 'notice:test-send-1:4', 'Other', '{}');
    `);
    const res = await post({
      ...base,
      message: 'Hi {name}',
      recipients: [
        { userId: 3, params: { name: 'a' } },
        { userId: 4, params: { name: 'b' } },
      ],
    });
    expect(res.json().counts).toMatchObject({ queued: 1, alreadySent: 1 });
  });

  it('refuses the same sendId with different text or url (409), in both modes', async () => {
    await post({ ...base, userIds: [1] });
    expect((await post({ ...base, message: 'Changed', userIds: [1] })).statusCode).toBe(409);
    expect((await post({ ...base, url: '/other', mode: 'send', userIds: [1] })).statusCode).toBe(
      409
    );
    expect(await pending()).toEqual([]);
  });

  it('refuses a concurrent call on the same sendId (409), dry runs included', async () => {
    await holdLease('send:test-send-1', '10 minutes');
    expect((await post({ ...base, userIds: [1] })).statusCode).toBe(409);
    expect((await post({ ...base, mode: 'send', userIds: [1] })).statusCode).toBe(409);
    expect(
      (await post({ ...base, sendId: 'other-send', mode: 'send', userIds: [1] })).statusCode
    ).toBe(200);
  });

  it('runs one send at a time across sendIds (409), while dry runs still proceed', async () => {
    await holdLease('global-send', '10 minutes');
    expect((await post({ ...base, mode: 'send', userIds: [1] })).statusCode).toBe(409);
    expect((await post({ ...base, userIds: [1] })).statusCode).toBe(200);
    expect(await pending()).toEqual([]);
  });

  it('holds the lease across statements on different pooled connections', async () => {
    let concurrent: number | undefined;
    h.beforePendingInsert = async () => {
      concurrent = (await post({ ...base, userIds: [1] })).statusCode;
    };
    const res = await post({ ...base, mode: 'send', userIds: [1] });
    expect(res.statusCode).toBe(200);
    expect(concurrent).toBe(409);
    expect(await leases()).toBe(0);
  });

  it('takes over an expired lease, so a crashed call cannot block the send forever', async () => {
    await holdLease('send:test-send-1', '-1 minute');
    await holdLease('global-send', '-1 minute');
    const res = await post({ ...base, mode: 'send', userIds: [1] });
    expect(res.statusCode).toBe(200);
    expect(await leases()).toBe(0);
  });

  it('releases only its own lease, never one another call took over after expiry', async () => {
    h.beforePendingInsert = async () => {
      await h.notif.query(
        `UPDATE "NoticeSendLease" SET holder = 'another-call' WHERE name = 'global-send'`
      );
    };
    await post({ ...base, mode: 'send', userIds: [1] });
    const left = await h.notif.query<{ name: string }>(`SELECT name FROM "NoticeSendLease"`);
    expect(left.rows).toEqual([{ name: 'global-send' }]);
  });
});

describe('failures', () => {
  it('a failed write returns 5xx with the written count, releases its locks, and a retry completes', async () => {
    h.failPendingInsertAfter = 0;
    const res = await post({
      ...base,
      mode: 'send',
      message: 'Hi {name}',
      recipients: [{ userId: 1, params: { name: 'a' } }],
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ written: 0 });
    expect(res.json().error).not.toContain('insert boom');
    expect(await leases()).toBe(0);

    h.failPendingInsertAfter = Infinity;
    const retry = await post({
      ...base,
      mode: 'send',
      message: 'Hi {name}',
      recipients: [{ userId: 1, params: { name: 'a' } }],
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().counts.queued).toBe(1);
  });
});

describe('ceiling accounting when the audit write fails', () => {
  it('still counts queued recipients toward the ceiling and reports the failure', async () => {
    h.failOn = 'UPDATE "NoticeSend" SET';
    const res = await post({ ...base, mode: 'send', userIds: [1, 2, 3, 4, 6, 7] });
    expect(res.statusCode).toBe(500);
    expect((await pending())[0].users).toHaveLength(6);
    h.failOn = undefined;
    const over = await post({
      ...base,
      sendId: 'test-send-2',
      mode: 'send',
      userIds: [1, 2, 3, 4, 6],
    });
    expect(over.statusCode).toBe(429);
  });
});

describe('validation (whole call fails, nothing written)', () => {
  const cases: Array<[string, object]> = [
    ['missing param', { message: 'Hi {name}', recipients: [{ userId: 1, params: {} }] }],
    ['extra param', { message: 'Hi', recipients: [{ userId: 1, params: { name: 'x' } }] }],
    [
      'param over 100 chars',
      { message: 'Hi {n}', recipients: [{ userId: 1, params: { n: 'x'.repeat(101) } }] },
    ],
    ['placeholder with plain userIds', { message: 'Hi {name}', userIds: [1] }],
    ['both userIds and recipients', { userIds: [1], recipients: [{ userId: 2, params: {} }] }],
    ['neither userIds nor recipients', {}],
    ['zero recipients', { userIds: [] }],
    ['over 50,000 recipients', { userIds: Array.from({ length: 50_001 }, (_, i) => i + 1) }],
    ['duplicate userIds', { userIds: [1, 1] }],
    ['url not a site path', { url: 'https://evil.example', userIds: [1] }],
    ['protocol-relative url', { url: '//evil.example', userIds: [1] }],
    ['backslash url', { url: '/\\evil.example', userIds: [1] }],
    ['backslash-slash url', { url: '/\\/evil.example', userIds: [1] }],
    ['tab-smuggled url', { url: '/\t/evil.example', userIds: [1] }],
    ['type outside the allowlist', { type: 'tos-violation', userIds: [1] }],
    ['HTML in message', { message: '<b>hi</b>', userIds: [1] }],
    ['missing sentBy', { sentBy: undefined, userIds: [1] }],
    ['missing reason', { reason: undefined, userIds: [1] }],
    ['bad sendId', { sendId: 'Has Spaces', userIds: [1] }],
  ];
  it.each(cases)('rejects %s', async (_, override) => {
    const res = await post({ ...base, mode: 'send', ...override });
    expect(res.statusCode).toBe(400);
    expect(await pending()).toEqual([]);
  });

  it('accepts a site path with a query and fragment', async () => {
    const res = await post({ ...base, url: '/models/1?tab=reviews#top', userIds: [1] });
    expect(res.statusCode).toBe(200);
  });

  it('names every failing recipient', async () => {
    const res = await post({
      ...base,
      message: 'Hi {name}',
      recipients: [
        { userId: 1, params: { name: 'ok' } },
        { userId: 2, params: {} },
        { userId: 3, params: { name: 'x', extra: 'y' } },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('failing userIds: 2, 3');
  });
});

describe('token scope', () => {
  it('the notices token opens the notices routes', async () => {
    expect((await post({ ...base, userIds: [1] })).statusCode).toBe(200);
    expect(
      (await post({ sendId: base.sendId }, { url: '/notifications/notices/get' })).statusCode
    ).toBe(200);
  });

  it('the producer token is refused on the notices routes', async () => {
    expect((await post({ ...base, userIds: [1] }, { token: PRODUCER_TOKEN })).statusCode).toBe(401);
    expect(
      (
        await post(
          { sendId: base.sendId },
          { url: '/notifications/notices/get', token: PRODUCER_TOKEN }
        )
      ).statusCode
    ).toBe(401);
  });

  it('no token is refused', async () => {
    expect((await post({ ...base, userIds: [1] }, { token: '' })).statusCode).toBe(401);
  });

  it.each([
    [
      '/notifications',
      { key: 'k', type: 'system-message', category: 'Other', userId: 1, details: {} },
    ],
    ['/notifications/bulk', []],
    ['/notifications/query', { userId: 1 }],
    ['/notifications/exists', { key: 'k' }],
    ['/notifications/cleanup', { before: new Date().toISOString() }],
  ])('the notices token is refused on %s', async (url, payload) => {
    expect((await post(payload, { url })).statusCode).toBe(401);
  });

  it('positive control: the producer token still opens a producer route', async () => {
    expect(
      (await post({ key: 'k' }, { url: '/notifications/exists', token: PRODUCER_TOKEN })).statusCode
    ).toBe(200);
  });
});

describe('token scope with the notices token unset', () => {
  let closedApp: FastifyInstance;
  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv('NOTIFICATIONS_NOTICES_TOKEN', '');
    const { buildServer } = await import('../../app');
    closedApp = await buildServer();
    await closedApp.ready();
    vi.stubEnv('NOTIFICATIONS_NOTICES_TOKEN', NOTICES_TOKEN);
  }, 60_000);
  afterAll(() => closedApp.close());

  it.each([
    ['an empty x-webhook-token', { 'x-webhook-token': '' }],
    ['an empty Bearer', { authorization: 'Bearer ' }],
    ['no header', {}],
    ['the producer token', { authorization: `Bearer ${PRODUCER_TOKEN}` }],
  ])('refuses %s', async (_, headers) => {
    const res = await closedApp.inject({
      method: 'POST',
      url: '/notifications/notices',
      headers,
      payload: { ...base, userIds: [1] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('rolling 24h ceiling', () => {
  it('refuses a send that would pass the ceiling (429 with the remaining allowance); dry runs do not count', async () => {
    await post({ ...base, userIds: [1, 2, 3, 4, 6, 7, 8] });
    const first = await post({ ...base, mode: 'send', userIds: [1, 2, 3, 4, 6, 7] });
    expect(first.json().counts.queued).toBe(6);

    const over = await post({
      ...base,
      sendId: 'test-send-2',
      mode: 'send',
      userIds: [1, 2, 3, 4, 6],
    });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ remaining: CEILING - 6 });

    const under = await post({
      ...base,
      sendId: 'test-send-2',
      mode: 'send',
      userIds: [1, 2, 3, 4],
    });
    expect(under.statusCode).toBe(200);
    expect(under.json().counts.queued).toBe(4);
  });

  it('ignores sends older than 24 hours', async () => {
    await post({ ...base, mode: 'send', userIds: [1, 2, 3, 4, 6, 7] });
    await h.notif.exec(`UPDATE "NoticeSendCall" SET "createdAt" = now() - interval '25 hours'`);
    const res = await post({
      ...base,
      sendId: 'test-send-2',
      mode: 'send',
      userIds: [1, 2, 3, 4, 6, 7],
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('audit record', () => {
  it('records the template, who, and summed send counts per sendId', async () => {
    await post({ ...base, userIds: [1, 999] });
    await post({ ...base, mode: 'send', userIds: [1, 999] });
    await post({ ...base, mode: 'send', userIds: [1, 2] });
    const res = await post({ sendId: base.sendId }, { url: '/notifications/notices/get' });
    expect(res.json()).toMatchObject({
      sendId: 'test-send-1',
      message: 'Hello there',
      sentBy: 'test',
      reason: 'hq:test',
      credential: 'notices-token',
      requested: 4,
      queued: 2,
      unknownUser: 1,
      alreadySent: 1,
      dryRuns: 1,
      sends: 2,
    });
  });

  it('records who made each call, and keeps the first caller on the send', async () => {
    await post({ ...base, userIds: [1] });
    await post({ ...base, mode: 'send', sentBy: 'second', reason: 'hq:other', userIds: [1] });
    const calls = (
      await h.notif.query<{ mode: string; sentBy: string; reason: string; credential: string }>(
        `SELECT mode, "sentBy", reason, credential FROM "NoticeSendCall" ORDER BY id`
      )
    ).rows;
    expect(calls).toEqual([
      { mode: 'dry-run', sentBy: 'test', reason: 'hq:test', credential: 'notices-token' },
      { mode: 'send', sentBy: 'second', reason: 'hq:other', credential: 'notices-token' },
    ]);
    const send = await post({ sendId: base.sendId }, { url: '/notifications/notices/get' });
    expect(send.json()).toMatchObject({ sentBy: 'test', reason: 'hq:test' });
  });

  it('404s an unknown sendId', async () => {
    const res = await post({ sendId: 'nope' }, { url: '/notifications/notices/get' });
    expect(res.statusCode).toBe(404);
  });
});
