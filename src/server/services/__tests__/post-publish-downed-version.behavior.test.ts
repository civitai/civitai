import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as Caches from '~/server/redis/caches';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as Submit from '~/server/services/text-scan/submit';
import type * as Visibility from '~/server/services/model-version-visibility.service';

/**
 * A moderator's take-down unpublishes the version's posts. Publishing one afterwards went straight
 * through updatePost, which never looked at the version, so an owner could put a taken-down post back
 * up, or publish a new one on the downed version. The guard runs in the publish UPDATE itself.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: async () => undefined,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  preventReplicationLag: async () => undefined,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    userPostCountCache: { ...actual.userPostCountCache, refresh: async () => undefined },
    userImageVideoCountCaches: {
      ...actual.userImageVideoCountCaches,
      refresh: async () => undefined,
    },
  };
});
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: () => undefined,
}));

const { canView } = vi.hoisted(() => ({ canView: { value: true } }));
vi.mock('~/server/services/model-version-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Visibility>()),
  canViewModelVersion: async () => canView.value,
}));

const OWNER = 5;
const MOD = 9;
// Versions: 10 live, 11 taken down (violation), 12 deleted, 13 live on a taken-down model.
const LIVE = 10;
const DOWNED = 11;
const DELETED = 12;
const ON_DOWNED_MODEL = 13;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamptz, metadata jsonb NOT NULL DEFAULT '{}'
    );
    INSERT INTO "Model" VALUES (1, 'Published'), (2, 'UnpublishedViolation');
    INSERT INTO "ModelVersion" VALUES
      (${LIVE}, 1, 'Published'), (${DOWNED}, 1, 'UnpublishedViolation'),
      (${DELETED}, 1, 'Deleted'), (${ON_DOWNED_MODEL}, 2, 'Published');
  `);
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE "Post";`);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
  // The ORM half of the update writes nothing the guard depends on; it returns the post as it is.
  dbMock.dbWrite.post.update.mockImplementation((async ({ where }: { where: { id: number } }) => {
    const { rows } = await pg.query(`SELECT * FROM "Post" WHERE id = $1`, [where.id]);
    return rows[0];
  }) as never);
  dbMock.dbWrite.post.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const { rows } = await pg.query(`SELECT * FROM "Post" WHERE id = $1`, [where.id]);
    return rows[0] ?? null;
  }) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
});

const { createPost, updatePost } = await import('~/server/services/post.service');

const draftOn = async (modelVersionId: number) => {
  await pg.query(`INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (1, $1, $2)`, [
    OWNER,
    modelVersionId,
  ]);
};
const publish = (asModerator = false) =>
  updatePost({
    id: 1,
    publishedAt: new Date(),
    user: { id: asModerator ? MOD : OWNER, isModerator: asModerator } as never,
  } as never);
const isPublished = async () =>
  (await pg.query<{ publishedAt: Date | null }>(`SELECT "publishedAt" FROM "Post" WHERE id = 1`))
    .rows[0].publishedAt !== null;

describe('publishing a post on a version a moderator took down', () => {
  it.each([
    ['a version taken down for a violation', DOWNED],
    ['a deleted version', DELETED],
    ['a live version of a taken-down model', ON_DOWNED_MODEL],
  ])('refuses the owner on %s, and leaves it unpublished', async (_label, version) => {
    await draftOn(version);

    await expect(publish()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await isPublished()).toBe(false);
  });

  it('lets a moderator publish it', async () => {
    await draftOn(DOWNED);

    await publish(true);
    expect(await isPublished()).toBe(true);
  });

  it('still publishes on a live version', async () => {
    await draftOn(LIVE);

    await publish();
    expect(await isPublished()).toBe(true);
  });
});

describe('an already-public post on a taken-down version', () => {
  it('still writes nothing and refuses nothing, as before the guard', async () => {
    // Left up until the clean-up runs; a re-sent publishedAt must not turn an edit into an error.
    await pg.query(
      `INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (1, $1, $2, now() - interval '1 day')`,
      [OWNER, DOWNED]
    );

    await expect(publish()).resolves.toBeTruthy();
  });
});

describe('creating a post already published', () => {
  // Past the guard createPost writes the post; stopping there shows the guard let it by.
  const PASSED_GUARD = 'passed the publish guard';
  beforeEach(() => {
    canView.value = true;
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      model: { availability: 'Public' },
    } as never);
    dbMock.dbWrite.post.create.mockRejectedValue(new Error(PASSED_GUARD) as never);
  });
  const create = (modelVersionId: number, publishedAt?: Date, isModerator = false) =>
    createPost({ userId: OWNER, isModerator, modelVersionId, publishedAt } as never);

  it('refuses the owner on a taken-down version', async () => {
    await expect(create(DOWNED, new Date())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('says not found, not taken down, for a version the caller cannot see', async () => {
    canView.value = false;
    await expect(create(DOWNED, new Date())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['a draft on a taken-down version', DOWNED, undefined, false],
    ['a moderator', DOWNED, new Date(), true],
    ['a live version', LIVE, new Date(), false],
  ])('lets %s through', async (_label, version, publishedAt, isModerator) => {
    await expect(create(version, publishedAt, isModerator)).rejects.toThrow(PASSED_GUARD);
  });
});
