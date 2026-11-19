import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The claim / repeat / takeover rules of the Postgres idempotency keys, against the real migration
 * in PGlite, and the sysRedis path the flag leaves in place. sysRedis is an in-memory map.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({ isFlipt: vi.fn(async () => false) }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: h.isFlipt,
}));

const {
  claimIdempotencyKey,
  purgeExpiredIdempotencyKeys,
  isUndefinedTableError,
  IdempotencyUnavailableError,
} = await import('~/server/services/idempotency-key.service');

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20271119120000_idempotency_key/migration.sql'
  ),
  'utf8'
);

let pg: PGlite;
let noTable: PGlite;
const db = pgliteKysely(() => pg);
const dbNoTable = pgliteKysely(() => noTable);
const sys = new Map<string, string>();

type Row = { scope: string; key: string; state: string; result: unknown; ttl: number };
const rows = async () =>
  (
    await pg.query<Row>(`
      SELECT scope, key, state, result,
             round(extract(epoch FROM "expiresAt" - "createdAt"))::int AS ttl
      FROM "IdempotencyKey" ORDER BY scope, key`)
  ).rows;

const HP = 'headless-post:idempotency';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(MIGRATION);
  noTable = new PGlite();
});
afterAll(async () => {
  await pg?.close();
  await noTable?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.isFlipt.mockResolvedValue(false);
  sys.clear();
  await pg.exec('DELETE FROM "IdempotencyKey"');
  redisMock.sysRedis.set.mockReset().mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean }
  ) => {
    if (opts?.NX && sys.has(key)) return null;
    sys.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.get
    .mockReset()
    .mockImplementation((async (key: string) => sys.get(key) ?? null) as never);
  redisMock.sysRedis.del
    .mockReset()
    .mockImplementation((async (key: string) => Number(sys.delete(key))) as never);
});

describe('flag off: sysRedis only, as before', () => {
  it('claims, refuses a repeat while pending, stores, answers a repeat, and frees', async () => {
    // A database with no table: any Postgres statement would throw.
    const deps = { db: dbNoTable };
    const first = await claimIdempotencyKey('headless-post', '7:k1', deps);
    const busy = await claimIdempotencyKey('headless-post', '7:k1', deps);
    await first.store('{"postId":51}');
    const repeat = await claimIdempotencyKey('headless-post', '7:k1', deps);
    await first.release();

    expect(h.isFlipt).toHaveBeenCalledWith('idempotency-keys-pg');
    expect([first.status, busy.status, repeat.status]).toEqual(['claimed', 'pending', 'done']);
    expect(repeat.result).toBe('{"postId":51}');
    expect(redisMock.sysRedis.set.mock.calls).toEqual([
      [`${HP}:7:k1`, 'pending', { NX: true, EX: 300 }],
      [`${HP}:7:k1`, 'pending', { NX: true, EX: 300 }],
      [`${HP}:7:k1`, '{"postId":51}', { EX: 604800 }],
      [`${HP}:7:k1`, 'pending', { NX: true, EX: 300 }],
    ]);
    expect(redisMock.sysRedis.del.mock.calls).toEqual([[`${HP}:7:k1`]]);
    expect(sys.size).toBe(0);
  });

  it('message-as-civitai keeps its 5-minute pending and 1-day result', async () => {
    const claim = await claimIdempotencyKey('message-as-civitai', '11:key-1:abc', {
      db: dbNoTable,
    });
    await claim.store('{"chatId":3,"messageId":4}');

    expect(redisMock.sysRedis.set.mock.calls).toEqual([
      ['message-as-civitai:idempotency:11:key-1:abc', 'pending', { NX: true, EX: 300 }],
      ['message-as-civitai:idempotency:11:key-1:abc', '{"chatId":3,"messageId":4}', { EX: 86400 }],
    ]);
  });

  it('stripe-air is a 30-day marker: a repeat is taken without reading the value', async () => {
    const first = await claimIdempotencyKey('stripe-air', 'cs_1', { db: dbNoTable });
    const repeat = await claimIdempotencyKey('stripe-air', 'cs_1', { db: dbNoTable });

    expect([first.status, repeat.status]).toEqual(['claimed', 'taken']);
    expect(redisMock.sysRedis.set.mock.calls[0]).toEqual([
      'webhooks:stripe:air-notified:cs_1',
      '1',
      { NX: true, EX: 2592000 },
    ]);
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });
});

describe('flag on: Postgres decides', () => {
  beforeEach(() => {
    h.isFlipt.mockResolvedValue(true);
  });

  it('claims in Postgres and writes sysRedis alongside', async () => {
    const claim = await claimIdempotencyKey('headless-post', '7:k2', { db });

    expect(claim.status).toBe('claimed');
    expect(await rows()).toEqual([
      { scope: 'headless-post', key: '7:k2', state: 'pending', result: null, ttl: 300 },
    ]);
    expect(sys.get(`${HP}:7:k2`)).toBe('pending');
  });

  it('a repeat after sysRedis lost the key is refused while pending and answered once done', async () => {
    const first = await claimIdempotencyKey('headless-post', '7:k3', { db });
    sys.clear();
    const busy = await claimIdempotencyKey('headless-post', '7:k3', { db });
    await first.store('{"postId":52,"imageIds":[8]}');
    sys.clear();
    const repeat = await claimIdempotencyKey('headless-post', '7:k3', { db });

    expect([first.status, busy.status, repeat.status]).toEqual(['claimed', 'pending', 'done']);
    expect(JSON.parse(repeat.result!)).toEqual({ postId: 52, imageIds: [8] });
    expect(await rows()).toEqual([
      {
        scope: 'headless-post',
        key: '7:k3',
        state: 'done',
        result: { postId: 52, imageIds: [8] },
        ttl: 604800,
      },
    ]);
  });

  it('stores the result in sysRedis too, with the same TTL as before', async () => {
    const claim = await claimIdempotencyKey('message-as-civitai', '11:k4', { db });
    await claim.store('{"chatId":5,"messageId":6}');

    expect(redisMock.sysRedis.set).toHaveBeenLastCalledWith(
      'message-as-civitai:idempotency:11:k4',
      '{"chatId":5,"messageId":6}',
      { EX: 86400 }
    );
    expect((await rows())[0]).toMatchObject({ state: 'done', ttl: 86400 });
  });

  it('keeps scopes apart: the same key in another scope is a new claim', async () => {
    await claimIdempotencyKey('headless-post', 'same', { db });
    const other = await claimIdempotencyKey('message-as-civitai', 'same', { db });

    expect(other.status).toBe('claimed');
    expect((await rows()).map((r) => r.scope)).toEqual(['headless-post', 'message-as-civitai']);
  });

  it('takes over a pending claim whose time ran out, but not one still running', async () => {
    await pg.exec(`
      INSERT INTO "IdempotencyKey" (scope, key, state, "createdAt", "expiresAt") VALUES
        ('headless-post', 'stale', 'pending', now() - interval '10 minutes', now() - interval '1 second'),
        ('headless-post', 'live', 'pending', now() - interval '1 minute', now() + interval '4 minutes')`);

    const stale = await claimIdempotencyKey('headless-post', 'stale', { db });
    const live = await claimIdempotencyKey('headless-post', 'live', { db });

    expect([stale.status, live.status]).toEqual(['claimed', 'pending']);
    expect((await rows()).map((r) => [r.key, r.state, r.ttl])).toEqual([
      ['live', 'pending', 300],
      ['stale', 'pending', 300],
    ]);
  });

  it('treats a result past its expiry as gone, as sysRedis would, until the purge deletes it', async () => {
    await pg.exec(`
      INSERT INTO "IdempotencyKey" (scope, key, state, result, "createdAt", "expiresAt") VALUES
        ('headless-post', 'old', 'done', '{"postId":1}', now() - interval '8 days', now() - interval '1 day')`);

    const claim = await claimIdempotencyKey('headless-post', 'old', { db });

    expect(claim.status).toBe('claimed');
    expect(await rows()).toEqual([
      { scope: 'headless-post', key: 'old', state: 'pending', result: null, ttl: 300 },
    ]);
  });

  it("frees only its own claim: one taken over after it lapsed is the next caller's", async () => {
    const first = await claimIdempotencyKey('headless-post', '7:k5', { db });
    await pg.exec(`UPDATE "IdempotencyKey" SET "expiresAt" = now() - interval '1 second'`);
    sys.clear();
    const second = await claimIdempotencyKey('headless-post', '7:k5', { db });

    await first.release().catch(() => undefined);
    const afterFirst = await rows();
    await second.release();

    expect(second.status).toBe('claimed');
    expect(afterFirst.map((r) => r.state)).toEqual(['pending']);
    expect(await rows()).toEqual([]);
  });

  it('release frees both stores, so a retry can claim', async () => {
    const first = await claimIdempotencyKey('headless-post', '7:k6', { db });
    await first.release();
    const retry = await claimIdempotencyKey('headless-post', '7:k6', { db });

    expect(retry.status).toBe('claimed');
    expect(redisMock.sysRedis.del).toHaveBeenCalledWith(`${HP}:7:k6`);
  });

  it('stripe-air: the marker holds after sysRedis lost it, and is freed by release', async () => {
    const first = await claimIdempotencyKey('stripe-air', 'cs_2', { db });
    sys.clear();
    const repeat = await claimIdempotencyKey('stripe-air', 'cs_2', { db });
    const ttl = (await rows())[0]?.ttl;
    await first.release();

    expect([first.status, repeat.status]).toEqual(['claimed', 'taken']);
    expect(ttl).toBe(2592000);
    expect(await rows()).toEqual([]);
  });

  describe('a key sysRedis holds from before the flag', () => {
    it('answers with its result, leaving no Postgres claim', async () => {
      sys.set(`${HP}:7:k7`, '{"postId":53}');

      const claim = await claimIdempotencyKey('headless-post', '7:k7', { db });

      expect([claim.status, claim.result]).toEqual(['done', '{"postId":53}']);
      expect(await rows()).toEqual([]);
    });

    it('refuses while its sysRedis claim is still pending', async () => {
      sys.set(`${HP}:7:k8`, 'pending');

      const claim = await claimIdempotencyKey('headless-post', '7:k8', { db });

      expect(claim.status).toBe('pending');
      expect(await rows()).toEqual([]);
    });

    it('a stripe-air marker from before the flag is taken', async () => {
      sys.set('webhooks:stripe:air-notified:cs_3', '1');

      const claim = await claimIdempotencyKey('stripe-air', 'cs_3', { db });

      expect(claim.status).toBe('taken');
      expect(await rows()).toEqual([]);
    });

    it('a repeat that stores again (a gallery sent on the repeat) records the result in Postgres', async () => {
      sys.set(`${HP}:7:k10`, '{"postId":55}');

      const claim = await claimIdempotencyKey('headless-post', '7:k10', { db });
      await claim.store('{"postId":55,"gallery":{"submitted":true}}');

      expect(claim.status).toBe('done');
      expect(await rows()).toEqual([
        {
          scope: 'headless-post',
          key: '7:k10',
          state: 'done',
          result: { postId: 55, gallery: { submitted: true } },
          ttl: 604800,
        },
      ]);
    });
  });

  describe('when sysRedis is down', () => {
    beforeEach(() => {
      redisMock.sysRedis.set.mockRejectedValue(new Error('sysRedis unavailable'));
    });

    it('refuses (an older sysRedis claim cannot be ruled out) and frees the Postgres claim', async () => {
      await expect(claimIdempotencyKey('headless-post', '7:k11', { db })).rejects.toBeInstanceOf(
        IdempotencyUnavailableError
      );
      expect(await rows()).toEqual([]);
    });

    it('a result that cannot be written to sysRedis too is reported as not stored', async () => {
      redisMock.sysRedis.set.mockReset().mockImplementation((async (
        key: string,
        value: string,
        opts?: { NX?: boolean }
      ) => {
        if (!opts?.NX) throw new Error('sysRedis unavailable');
        sys.set(key, value);
        return 'OK';
      }) as never);

      const claim = await claimIdempotencyKey('headless-post', '7:k12', { db });

      await expect(claim.store('{"postId":56}')).rejects.toThrow('sysRedis unavailable');
    });
  });

  it('with the table missing: refuses before claiming anything anywhere', async () => {
    const error = await claimIdempotencyKey('headless-post', '7:k13', { db: dbNoTable }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(IdempotencyUnavailableError);
    expect(error).toMatchObject({ scope: 'headless-post', tableMissing: true });
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
    expect(sys.size).toBe(0);
  });
});

describe('purgeExpiredIdempotencyKeys', () => {
  it('deletes only expired rows, in batches', async () => {
    await pg.exec(`
      INSERT INTO "IdempotencyKey" (scope, key, state, result, "expiresAt") VALUES
        ('headless-post', 'a', 'done', '{}', now() - interval '1 hour'),
        ('headless-post', 'b', 'pending', NULL, now() - interval '1 second'),
        ('stripe-air', 'c', 'pending', NULL, now() - interval '3 days'),
        ('headless-post', 'd', 'done', '{}', now() + interval '1 hour'),
        ('message-as-civitai', 'e', 'pending', NULL, now() + interval '5 minutes')`);

    const deleted = await purgeExpiredIdempotencyKeys({ db, batch: 2 });

    expect(deleted).toBe(3);
    expect((await rows()).map((r) => r.key)).toEqual(['d', 'e']);
  });

  it('throws a recognisable error while the table is not applied', async () => {
    const error = await purgeExpiredIdempotencyKeys({ db: dbNoTable }).catch((e: unknown) => e);

    expect(isUndefinedTableError(error)).toBe(true);
  });
});

describe('the migration', () => {
  it('refuses a state other than pending or done', async () => {
    await expect(
      pg.query(
        `INSERT INTO "IdempotencyKey" (scope, key, state, "expiresAt") VALUES ('x', 'y', 'sent', now())`
      )
    ).rejects.toThrow(/IdempotencyKey_state_check/);
  });

  it('can be applied twice', async () => {
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
  });
});

describe('a sysRedis key always counts, whatever the date the flag is turned on', () => {
  // A flag first turned on long after this PR: a pod without the flag yet may be mid-send.
  beforeEach(() => {
    h.isFlipt.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-06-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses while a sysRedis claim is pending, leaving no Postgres claim', async () => {
    sys.set(`${HP}:7:k20`, 'pending');

    const claim = await claimIdempotencyKey('headless-post', '7:k20', { db });

    expect(claim.status).toBe('pending');
    expect(await rows()).toEqual([]);
  });

  it('answers with the result sysRedis holds, without acting again', async () => {
    sys.set(`${HP}:7:k21`, '{"postId":57}');

    const claim = await claimIdempotencyKey('headless-post', '7:k21', { db });

    expect([claim.status, claim.result]).toEqual(['done', '{"postId":57}']);
    expect(await rows()).toEqual([]);
  });

  it('a stripe-air marker in sysRedis is taken', async () => {
    sys.set('webhooks:stripe:air-notified:cs_20', '1');

    const claim = await claimIdempotencyKey('stripe-air', 'cs_20', { db });

    expect(claim.status).toBe('taken');
  });
});

describe('purgeExpiredIdempotencyKeys statement', () => {
  it('re-checks expiry on the row it deletes, so a claim taken over meanwhile survives', async () => {
    // A takeover between the LIMIT subquery and the DELETE's row lock leaves (scope, key)
    // matching after the recheck; only a predicate on the deleted row itself spares the new claim.
    const seen: string[] = [];
    const recording = pgliteKysely(
      () =>
        ({
          query: (text: string, params: unknown[]) => {
            seen.push(text.replace(/\s+/g, ' ').trim());
            return pg.query(text, params);
          },
        } as unknown as PGlite)
    );

    await purgeExpiredIdempotencyKeys({ db: recording, batch: 10 });

    expect(seen).toEqual([
      'DELETE FROM "IdempotencyKey" WHERE "expiresAt" < now() AND (scope, key) IN ( SELECT scope, key FROM "IdempotencyKey" WHERE "expiresAt" < now() LIMIT $1 )',
    ]);
  });
});
