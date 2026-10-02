import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as CreatorMembershipService from '~/server/services/creator-membership.service';
import { createGate, createPrismaBridge } from './user-settings-race.harness';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn(() => ({
    fetch: async () => ({}),
    bust: async () => undefined,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));

vi.mock('~/server/services/creator-membership.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorMembershipService>()),
  bustUserMetricPrivacyDefaultsCache: vi.fn(async () => undefined),
}));

const { getGallerySettingsByModelId } = await import('~/server/services/model.service');
const { getModel3DGallerySettings } = await import('~/server/services/model3d.service');
const {
  addCreatorGalleryHiddenUser,
  getCreatorGalleryHiddenUserIds,
  getCreatorGalleryHiddenUsers,
  removeCreatorGalleryHiddenUser,
  updateCreatorGalleryHiddenUserNote,
} = await import('~/server/services/creator-gallery-hidden-users.service');

const CREATOR = 100;
const OTHER_CREATOR = 101;
const MODEL_HIDDEN = 200;
const CREATOR_HIDDEN = 201;
const DELETED_USER = 202;
const SOFT_DELETED_USER = 203;
const MODEL_ID = 900;
const MODEL3D_ID = 950;
const SECRET_NOTE = 'spams-every-model-zqx';
const CAP = 1000;

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20260925150000_creator_gallery_hidden_user/migration.sql'
);

let db: PGlite;
let creatorModelIds: number[] = [];
// Every write-side step of an add, in order, with whether a transaction callback was running.
// `via` is the client the call went through: 'tx' is the transaction callback's own client.
let ops: { op: string; via: 'tx' | 'dbWrite' }[] = [];

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows as T[];

type Key = { creatorId: number; userId: number };

const rowsFor = (creatorId: number) =>
  q<{ userId: number; note: string | null }>(
    `SELECT "userId", note FROM "CreatorGalleryHiddenUser" WHERE "creatorId" = $1 ORDER BY "userId"`,
    [creatorId]
  );

const seedRows = (creatorId: number, count: number, firstUserId: number) =>
  q(
    `INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId")
     SELECT $1, g FROM generate_series($2::int, $2::int + $3::int - 1) g`,
    [creatorId, firstUserId, count]
  );

const deletedKeys = () => redisMock.redis.del.mock.calls.flatMap((call) => call[0]);

// The delegates below read every key they are given, so a caller that drops `creatorId` from a
// `where` addresses a different set of rows here, just as it would against Postgres.
async function countRows({ where }: { where: { creatorId?: number } }) {
  const [row] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "CreatorGalleryHiddenUser"
     WHERE ($1::int IS NULL OR "creatorId" = $1)`,
    [where.creatorId ?? null]
  );
  return row.n;
}

async function findRow({ where }: { where: { creatorId_userId: Key } }) {
  const { creatorId, userId } = where.creatorId_userId;
  const [row] = await q(
    `SELECT "userId" FROM "CreatorGalleryHiddenUser" WHERE "creatorId" = $1 AND "userId" = $2`,
    [creatorId, userId]
  );
  return row ?? null;
}

async function upsertRow({
  where,
  create,
  update,
}: {
  where: { creatorId_userId: Key };
  create: Key & { note: string | null };
  update: { note?: string | null };
}) {
  const { creatorId, userId } = where.creatorId_userId;
  const updated = await q(
    `UPDATE "CreatorGalleryHiddenUser" SET note = CASE WHEN $3 THEN $4 ELSE note END
     WHERE "creatorId" = $1 AND "userId" = $2 RETURNING "userId"`,
    [creatorId, userId, 'note' in update, update.note ?? null]
  );
  if (updated.length) return;
  await q(
    `INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId", note) VALUES ($1, $2, $3)`,
    [create.creatorId, create.userId, create.note]
  );
}

function installDb() {
  const bridge = createPrismaBridge(db, createGate());
  // Runs the statement for real, so a malformed lock call fails here.
  const executeRaw =
    (via: 'tx' | 'dbWrite') =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      ops.push({
        op: strings.join('?').includes('pg_advisory_xact_lock') ? 'lock' : 'execute',
        via,
      });
      return bridge.$executeRaw(strings, ...values);
    };
  dbMock.dbWrite.$executeRaw.mockImplementation(executeRaw('dbWrite'));
  // A client distinct from dbWrite, as Prisma's is: an advisory xact lock taken on dbWrite inside
  // the callback runs on another pooled connection and is released at once.
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const table = dbMock.dbWrite.creatorGalleryHiddenUser;
    const viaTx =
      (op: string, call: (...args: any[]) => unknown) =>
      (...args: unknown[]) => {
        ops.push({ op, via: 'tx' });
        return call(...args);
      };
    return fn({
      $executeRaw: executeRaw('tx'),
      creatorGalleryHiddenUser: {
        count: viaTx('count', countRows),
        findUnique: viaTx('findUnique', findRow),
        upsert: viaTx('upsert', upsertRow),
        updateMany: table.updateMany,
        deleteMany: table.deleteMany,
      },
    });
  });
  for (const root of [dbMock.dbRead, dbMock.dbWrite]) {
    root.$queryRaw.mockImplementation(bridge.$queryRaw);
    root.user.findFirst.mockImplementation(
      async ({ where }: { where: { id: number; deletedAt?: null } }) => {
        const [row] = await q(
          `SELECT id FROM "User" WHERE id = $1 AND (NOT $2 OR "deletedAt" IS NULL)`,
          [where.id, 'deletedAt' in where]
        );
        return row ?? null;
      }
    );
    root.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: number[] } } }) =>
      q(`SELECT id, username FROM "User" WHERE id = ANY($1::int[]) ORDER BY id`, [where.id.in])
    );
    root.model.findFirst.mockImplementation(async () => ({
      id: MODEL_ID,
      userId: CREATOR,
      gallerySettings: { users: [MODEL_HIDDEN], tags: [], images: [] },
    }));
    root.model3D.findUnique.mockImplementation(async () => ({
      id: MODEL3D_ID,
      userId: CREATOR,
      gallerySettings: { users: [MODEL_HIDDEN], tags: [], images: [] },
    }));
    root.model.findMany.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === CREATOR ? creatorModelIds.map((id) => ({ id })) : []
    );

    const table = root.creatorGalleryHiddenUser;
    const recordWrite =
      (op: string, call: (...args: any[]) => unknown) =>
      (...args: unknown[]) => {
        if (root === dbMock.dbWrite) ops.push({ op, via: 'dbWrite' });
        return call(...args);
      };
    table.count.mockImplementation(recordWrite('count', countRows));
    table.findUnique.mockImplementation(recordWrite('findUnique', findRow));
    table.upsert.mockImplementation(recordWrite('upsert', upsertRow));
    table.updateMany.mockImplementation(
      async ({ where, data }: { where: Partial<Key>; data: { note: string | null } }) => {
        const rows = await q(
          `UPDATE "CreatorGalleryHiddenUser" SET note = $3
           WHERE ($1::int IS NULL OR "creatorId" = $1) AND ($2::int IS NULL OR "userId" = $2)
           RETURNING "userId"`,
          [where.creatorId ?? null, where.userId ?? null, data.note]
        );
        return { count: rows.length };
      }
    );
    table.deleteMany.mockImplementation(async ({ where }: { where: Partial<Key> }) => {
      const rows = await q(
        `DELETE FROM "CreatorGalleryHiddenUser"
         WHERE ($1::int IS NULL OR "creatorId" = $1) AND ($2::int IS NULL OR "userId" = $2)
         RETURNING "userId"`,
        [where.creatorId ?? null, where.userId ?? null]
      );
      return { count: rows.length };
    });
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp);`);
  // The committed migration, not a hand copy, so a schema drift fails here.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  // Faked for every test: each bust schedules a second delete, and a real one could land in a
  // later test's assertions.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  ops = [];
  await db.exec(`TRUNCATE "User"; TRUNCATE "CreatorGalleryHiddenUser";`);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES
      (${CREATOR}, 'creator'), (${OTHER_CREATOR}, 'other-creator'),
      (${MODEL_HIDDEN}, 'model-hidden'), (${CREATOR_HIDDEN}, 'creator-hidden');
    INSERT INTO "User" (id, username, "deletedAt") VALUES (${SOFT_DELETED_USER}, 'gone', now());
    INSERT INTO "User" (id, username) SELECT g, 'bulk-' || g FROM generate_series(10000, 12100) g;
  `);
  creatorModelIds = [MODEL_ID, MODEL_ID + 1];
  installDb();
  redisMock.redis.get.mockResolvedValue(null);
  redisMock.redis.set.mockClear();
  redisMock.redis.del.mockClear();
  dbMock.dbWrite.$executeRaw.mockClear();
});

describe('creator gallery hidden users', () => {
  it('scopes the list to its creator and skips hard- and soft-deleted users', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    await q(
      `INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId")
       VALUES ($1, $2), ($1, $3), ($4, $5)`,
      [CREATOR, DELETED_USER, SOFT_DELETED_USER, OTHER_CREATOR, MODEL_HIDDEN]
    );

    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([CREATOR_HIDDEN]);
    expect((await getCreatorGalleryHiddenUsers(CREATOR)).map((u) => u.id)).toEqual([
      CREATOR_HIDDEN,
    ]);
    expect(await getCreatorGalleryHiddenUserIds(OTHER_CREATOR)).toEqual([MODEL_HIDDEN]);
  });

  it('refuses to hide an account that has been deleted', async () => {
    await expect(
      addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: SOFT_DELETED_USER })
    ).rejects.toThrow('User not found');
    expect(await rowsFor(CREATOR)).toEqual([]);
  });

  it("merges into a model's gallery settings without touching the model's own list", async () => {
    await addCreatorGalleryHiddenUser({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: SECRET_NOTE,
    });

    const settings = await getGallerySettingsByModelId({ id: MODEL_ID });

    expect(settings?.hiddenUsers).toEqual([{ id: MODEL_HIDDEN, username: 'model-hidden' }]);
    expect(settings?.creatorHiddenUserIds).toEqual([CREATOR_HIDDEN]);
  });

  it("merges into a 3D model's gallery settings the same way", async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    const settings = await getModel3DGallerySettings({ id: MODEL3D_ID });

    expect(settings?.hiddenUsers).toEqual([{ id: MODEL_HIDDEN, username: 'model-hidden' }]);
    expect(settings?.creatorHiddenUserIds).toEqual([CREATOR_HIDDEN]);
  });

  // The rebuild is cached for a week, so a lagging replica read would pin the pre-write list.
  it('rebuilds the cached gallery settings from the primary, not a lagging replica', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);

    const settings = await getGallerySettingsByModelId({ id: MODEL_ID });

    expect(settings?.creatorHiddenUserIds).toEqual([CREATOR_HIDDEN]);
  });

  // Decision: the note is private to the creator. getGallerySettings is a PUBLIC procedure and
  // this object is what it returns and what it caches, so the note must never be in it.
  it('never puts the private note in the public gallery settings payload or its cache', async () => {
    await addCreatorGalleryHiddenUser({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: SECRET_NOTE,
    });

    const settings = await getGallerySettingsByModelId({ id: MODEL_ID });
    const cached = redisMock.redis.set.mock.calls.map((call) => String(call[1])).join('\n');

    expect(cached).toContain(String(CREATOR_HIDDEN));
    expect(JSON.stringify(settings)).not.toContain(SECRET_NOTE);
    expect(cached).not.toContain(SECRET_NOTE);
    expect((await getCreatorGalleryHiddenUsers(CREATOR))[0].note).toBe(SECRET_NOTE);
  });

  it("busts every one of the creator's model gallery caches on add and on remove", async () => {
    const keys = [
      `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${MODEL_ID}`,
      `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${MODEL_ID + 1}`,
    ];

    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    expect(deletedKeys()).toEqual(keys);

    redisMock.redis.del.mockClear();
    await removeCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    expect(deletedKeys()).toEqual(keys);
    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([]);
  });

  it('busts every model of a creator with more models than one delete batch', async () => {
    creatorModelIds = Array.from({ length: 1201 }, (_, i) => i + 1);

    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    expect(new Set(deletedKeys()).size).toBe(1201);
    expect(deletedKeys()).toContain(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:1201`);
    expect(Math.max(...redisMock.redis.del.mock.calls.map((call) => call[0].length))).toBe(500);
  });

  // A rebuild that read the list before the write can SET after the first delete; the entry lives
  // a week, so without the second delete that stale list would too.
  it('deletes the gallery caches again after the rebuild window', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    expect(redisMock.redis.del).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(redisMock.redis.del).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(redisMock.redis.del).toHaveBeenCalledTimes(2);
    expect(redisMock.redis.del.mock.calls[1][0]).toEqual(redisMock.redis.del.mock.calls[0][0]);
  });

  it("edits and removes only the caller's own entry, never another creator's for the same user", async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'mine' });
    await addCreatorGalleryHiddenUser({
      creatorId: OTHER_CREATOR,
      userId: CREATOR_HIDDEN,
      note: 'theirs',
    });

    await updateCreatorGalleryHiddenUserNote({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: 'edited',
    });
    await removeCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    expect(await rowsFor(CREATOR)).toEqual([]);
    expect(await rowsFor(OTHER_CREATOR)).toEqual([{ userId: CREATOR_HIDDEN, note: 'theirs' }]);
  });

  it('edits a note without busting any gallery cache, and stores a blank note as null', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'a' });
    redisMock.redis.del.mockClear();

    await updateCreatorGalleryHiddenUserNote({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: 'b',
    });
    expect((await getCreatorGalleryHiddenUsers(CREATOR))[0].note).toBe('b');

    await updateCreatorGalleryHiddenUserNote({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: '',
    });
    expect((await getCreatorGalleryHiddenUsers(CREATOR))[0].note).toBeNull();
    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });

  it('reports a note edit for a user who is no longer on the list', async () => {
    await expect(
      updateCreatorGalleryHiddenUserNote({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'x' })
    ).rejects.toThrow('not on your hidden list');
  });

  it('stores a blank note on add as null', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: '' });

    expect(await rowsFor(CREATOR)).toEqual([{ userId: CREATOR_HIDDEN, note: null }]);
  });

  // Entries cached before this field existed have no creatorHiddenUserIds; the client treats that
  // as an empty list, and the hit path must not rebuild or reshape them.
  it('serves a cached entry as it was stored, without reading the database', async () => {
    const cached = {
      hiddenUsers: [],
      hiddenTags: [],
      hiddenImages: {},
      level: 31,
      pinnedPosts: {},
    };
    redisMock.redis.get.mockResolvedValue(JSON.stringify(cached));
    dbMock.dbRead.model.findFirst.mockClear();
    dbMock.dbWrite.model.findFirst.mockClear();

    expect(await getGallerySettingsByModelId({ id: MODEL_ID })).toEqual(cached);
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.findFirst).not.toHaveBeenCalled();
  });

  it('updates the note when an existing entry is saved again', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'old' });
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'new' });

    expect(await rowsFor(CREATOR)).toEqual([{ userId: CREATOR_HIDDEN, note: 'new' }]);
  });

  it('refuses to hide the creator from their own galleries', async () => {
    await expect(
      addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR })
    ).rejects.toThrow('You cannot hide yourself');
    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([]);
  });

  it("counts the cap per creator: another creator's full list does not block this one", async () => {
    await seedRows(OTHER_CREATOR, CAP, 10000);

    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    expect(await rowsFor(CREATOR)).toEqual([{ userId: CREATOR_HIDDEN, note: null }]);
  });

  it('refuses a new entry at the cap but still lets an existing entry be re-saved', async () => {
    await seedRows(CREATOR, CAP - 1, 10000);
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    await expect(
      addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: MODEL_HIDDEN })
    ).rejects.toThrow(`at most ${CAP}`);

    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'x' });
    expect((await rowsFor(CREATOR)).find((r) => r.userId === CREATOR_HIDDEN)?.note).toBe('x');
    expect(await rowsFor(CREATOR)).toHaveLength(CAP);
  });

  // The cap check and the write share one transaction behind a per-creator advisory lock.
  it('takes the per-creator lock inside the transaction that checks the cap', async () => {
    const lockArgs: unknown[][] = [];
    const bridged = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementationOnce((fn: (tx: any) => Promise<unknown>) =>
      bridged((tx: any) =>
        fn({
          ...tx,
          $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
            lockArgs.push(values);
            return tx.$executeRaw(strings, ...values);
          },
        })
      )
    );

    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });

    expect(ops.map((o) => o.op).sort()).toEqual(['count', 'findUnique', 'lock', 'upsert']);
    expect(ops[0].op).toBe('lock');
    expect(ops[ops.length - 1].op).toBe('upsert');
    expect(ops.filter((o) => o.via !== 'tx')).toEqual([]);
    expect(lockArgs).toEqual([[0x47480001, CREATOR]]);
  });
});
