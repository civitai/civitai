import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { banDisabledMarkKey } from '@civitai/auth/ban-disabled-mark';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { markBanDisabledClients, reopenBanDisabledClient } = await import('../oauth-ban-marker');

/**
 * The re-open's SQL runs on an in-process Postgres (the owner's ban and the client's mode are
 * conditions of the UPDATE itself, which a mock cannot judge); the mark lives on a fake cache Redis
 * behind the shared redis mock.
 */
const PRELUDE = `
  CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "bannedAt" TIMESTAMP(3));
  CREATE TABLE "OauthClient" (
    "id" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL, "accessMode" TEXT NOT NULL DEFAULT 'open'
  );`;

let pg: PGlite;
const sqlOf = (q: TemplateStringsArray, values: unknown[]) => Prisma.sql(q, ...values);

const CLIENT = 'appassist-7';
let marks: Map<string, { value: string; opts: unknown }>;

function installRedis() {
  marks = new Map();
  redisMock.redis.set.mockReset();
  redisMock.redis.set.mockImplementation((async (key: string, value: string, opts: unknown) => {
    marks.set(key, { value, opts });
    return 'OK';
  }) as never);
  redisMock.redis.get.mockReset();
  redisMock.redis.get.mockImplementation(
    (async (key: string) => marks.get(key)?.value ?? null) as never
  );
  redisMock.redis.del.mockReset();
  redisMock.redis.del.mockImplementation((async (key: string) =>
    marks.delete(key) ? 1 : 0) as never);
}

const modeOf = async (id: string) =>
  (
    await pg.query<{ accessMode: string }>(
      'SELECT "accessMode" FROM "OauthClient" WHERE "id" = $1',
      [id]
    )
  ).rows[0]?.accessMode;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
});
afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('TRUNCATE "User", "OauthClient"');
  await pg.query('INSERT INTO "User" ("id", "bannedAt") VALUES (7, NULL)');
  await pg.query(
    `INSERT INTO "OauthClient" ("id", "userId", "accessMode") VALUES ($1, 7, 'disabled')`,
    [CLIENT]
  );
  installRedis();
  dbMock.dbWrite.$executeRaw.mockReset();
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    q: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const s = sqlOf(q, v);
    return (await pg.query(s.text, s.values)).affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockImplementation((async (q: TemplateStringsArray, ...v: unknown[]) => {
    const s = sqlOf(q, v);
    return (await pg.query(s.text, s.values)).rows;
  }) as never);
});

describe('reopenBanDisabledClient', () => {
  it('🔴 an UNMARKED disabled client (staff, or never banned) is never re-opened', async () => {
    expect(await reopenBanDisabledClient(CLIENT)).toBe(false);
    expect(await modeOf(CLIENT)).toBe('disabled');
  });

  it('🔴 restores the mode the client had before the ban (testers stays testers) and spends the mark', async () => {
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'testers' }]);
    expect(marks.get(banDisabledMarkKey(CLIENT))?.value).toBe('testers');
    // Written with a TTL, so a mark never lingers forever (a lost mark fails closed).
    expect((marks.get(banDisabledMarkKey(CLIENT))?.opts as { EX?: number }).EX).toBeGreaterThan(0);

    expect(await reopenBanDisabledClient(CLIENT)).toBe(true);
    expect(await modeOf(CLIENT)).toBe('testers');
    expect(marks.size).toBe(0);
  });

  it('🔴 an owner banned again (after the caller’s own ban check) gets nothing re-opened, and the mark is kept for after that ban', async () => {
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'open' }]);
    await pg.query('UPDATE "User" SET "bannedAt" = CURRENT_TIMESTAMP WHERE "id" = 7');

    expect(await reopenBanDisabledClient(CLIENT)).toBe(false);
    expect(await modeOf(CLIENT)).toBe('disabled');
    expect(marks.get(banDisabledMarkKey(CLIENT))?.value).toBe('open');
  });

  it('🔴 a staff mode change between the mark check and the write wins: the mark is gone, nothing re-opens', async () => {
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'open' }]);
    // Staff clears the mark (the hub's setMode) after the re-open read it but before it consumed it.
    redisMock.redis.get.mockImplementationOnce((async (key: string) => {
      const v = marks.get(key)?.value ?? null;
      marks.delete(key);
      return v;
    }) as never);
    expect(await reopenBanDisabledClient(CLIENT)).toBe(false);
    expect(await modeOf(CLIENT)).toBe('disabled');
  });

  it('a client no longer disabled is left as it is, and its mark is not put back', async () => {
    await pg.query(`UPDATE "OauthClient" SET "accessMode" = 'testers' WHERE "id" = $1`, [CLIENT]);
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'open' }]);
    expect(await reopenBanDisabledClient(CLIENT)).toBe(false);
    expect(await modeOf(CLIENT)).toBe('testers');
    expect(marks.size).toBe(0);
  });

  it('🔴 a cache Redis error is "no mark": nothing re-opens and nothing throws', async () => {
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'open' }]);
    redisMock.redis.get.mockRejectedValueOnce(new Error('cache down'));
    await expect(reopenBanDisabledClient(CLIENT)).resolves.toBe(false);
    expect(await modeOf(CLIENT)).toBe('disabled');
  });

  it('a garbled mark re-opens nothing', async () => {
    await markBanDisabledClients([{ id: CLIENT, priorMode: 'disabled' }]);
    expect(await reopenBanDisabledClient(CLIENT)).toBe(false);
    expect(await modeOf(CLIENT)).toBe('disabled');
  });
});
