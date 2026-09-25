import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
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

vi.mock('~/server/services/creator-membership.service', () => ({
  bustUserMetricPrivacyDefaultsCache: vi.fn(async () => undefined),
}));

const { getGallerySettingsByModelId } = await import('~/server/services/model.service');
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
const MODEL_ID = 900;
const SECRET_NOTE = 'spams-every-model-zqx';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20260925150000_creator_gallery_hidden_user/migration.sql'
);

let db: PGlite;

const q = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows as T[];

function installDb() {
  const bridge = createPrismaBridge(db, createGate());
  for (const root of [dbMock.dbRead, dbMock.dbWrite]) {
    root.$queryRaw.mockImplementation(bridge.$queryRaw);
    root.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => {
      const [row] = await q<{ id: number }>(`SELECT id FROM "User" WHERE id = $1`, [where.id]);
      return row ?? null;
    });
    root.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: number[] } } }) =>
      q(`SELECT id, username FROM "User" WHERE id = ANY($1::int[]) ORDER BY id`, [where.id.in])
    );
    root.model.findFirst.mockImplementation(async () => ({
      id: MODEL_ID,
      userId: CREATOR,
      gallerySettings: { users: [MODEL_HIDDEN], tags: [], images: [] },
    }));
    root.model.findMany.mockImplementation(async ({ where }: { where: { userId: number } }) =>
      where.userId === CREATOR ? [{ id: MODEL_ID }, { id: MODEL_ID + 1 }] : []
    );

    const table = root.creatorGalleryHiddenUser;
    table.count.mockImplementation(async ({ where }: { where: { creatorId: number } }) => {
      const [row] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM "CreatorGalleryHiddenUser" WHERE "creatorId" = $1`,
        [where.creatorId]
      );
      return row.n;
    });
    table.findUnique.mockImplementation(
      async ({ where }: { where: { creatorId_userId: { creatorId: number; userId: number } } }) => {
        const { creatorId, userId } = where.creatorId_userId;
        const [row] = await q(
          `SELECT "userId" FROM "CreatorGalleryHiddenUser" WHERE "creatorId" = $1 AND "userId" = $2`,
          [creatorId, userId]
        );
        return row ?? null;
      }
    );
    table.upsert.mockImplementation(
      async ({ create }: { create: { creatorId: number; userId: number; note: string | null } }) =>
        q(
          `INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId", note) VALUES ($1, $2, $3)
           ON CONFLICT ("creatorId", "userId") DO UPDATE SET note = EXCLUDED.note`,
          [create.creatorId, create.userId, create.note]
        )
    );
    table.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { creatorId: number; userId: number };
        data: { note: string | null };
      }) =>
        q(
          `UPDATE "CreatorGalleryHiddenUser" SET note = $3 WHERE "creatorId" = $1 AND "userId" = $2`,
          [where.creatorId, where.userId, data.note]
        )
    );
    table.deleteMany.mockImplementation(
      async ({ where }: { where: { creatorId: number; userId: number } }) =>
        q(`DELETE FROM "CreatorGalleryHiddenUser" WHERE "creatorId" = $1 AND "userId" = $2`, [
          where.creatorId,
          where.userId,
        ])
    );
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "User" (id int PRIMARY KEY, username text);`);
  // The committed migration, not a hand copy, so a schema drift fails here.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "User"; TRUNCATE "CreatorGalleryHiddenUser";`);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES
      (${CREATOR}, 'creator'), (${OTHER_CREATOR}, 'other-creator'),
      (${MODEL_HIDDEN}, 'model-hidden'), (${CREATOR_HIDDEN}, 'creator-hidden');
  `);
  installDb();
  redisMock.redis.get.mockResolvedValue(null);
  redisMock.redis.set.mockClear();
  redisMock.redis.del.mockClear();
});

describe('creator gallery hidden users', () => {
  it('scopes the list to its creator and skips users that no longer exist', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    await q(
      `INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId") VALUES ($1, $2), ($3, $4)`,
      [CREATOR, DELETED_USER, OTHER_CREATOR, MODEL_HIDDEN]
    );

    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([CREATOR_HIDDEN]);
    expect(await getCreatorGalleryHiddenUserIds(OTHER_CREATOR)).toEqual([MODEL_HIDDEN]);
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
    expect(redisMock.redis.del.mock.calls.flatMap((call) => call[0])).toEqual(keys);

    redisMock.redis.del.mockClear();
    await removeCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN });
    expect(redisMock.redis.del.mock.calls.flatMap((call) => call[0])).toEqual(keys);
    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([]);
  });

  it('edits a note without busting any gallery cache', async () => {
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'a' });
    redisMock.redis.del.mockClear();

    await updateCreatorGalleryHiddenUserNote({
      creatorId: CREATOR,
      userId: CREATOR_HIDDEN,
      note: 'b',
    });

    expect((await getCreatorGalleryHiddenUsers(CREATOR))[0].note).toBe('b');
    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });

  it('refuses to hide the creator from their own galleries', async () => {
    await expect(
      addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR })
    ).rejects.toThrow('You cannot hide yourself');
    expect(await getCreatorGalleryHiddenUserIds(CREATOR)).toEqual([]);
  });

  it('refuses a new entry at the cap but still lets an existing entry be re-saved', async () => {
    dbMock.dbWrite.creatorGalleryHiddenUser.count.mockResolvedValue(1000);

    await expect(
      addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: MODEL_HIDDEN })
    ).rejects.toThrow('at most 1000');

    await q(`INSERT INTO "CreatorGalleryHiddenUser" ("creatorId", "userId") VALUES ($1, $2)`, [
      CREATOR,
      CREATOR_HIDDEN,
    ]);
    await addCreatorGalleryHiddenUser({ creatorId: CREATOR, userId: CREATOR_HIDDEN, note: 'x' });
    expect((await getCreatorGalleryHiddenUsers(CREATOR))[0].note).toBe('x');
  });
});
