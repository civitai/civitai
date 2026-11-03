import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000 });

/**
 * A draft is not scanned, so its stored floor can lag an edit. Scheduling or publishing rescans it,
 * and the submit skips text it already scanned, so the floor follows the text the post goes live with.
 */

vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  userPostCountCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntityInBackground: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

const { updatePost } = await import('~/server/services/post.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');

const OWNER = 10;
const owner = { id: OWNER, isModerator: false } as SessionUser;
const pg = { db: null as unknown as PGlite };

beforeAll(async () => {
  pg.db = await PGlite.create();
  await pg.db.exec(`
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "modelVersionId" int,
      "publishedAt" timestamp(3),
      metadata jsonb
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL, "userId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL);
  `);
});

afterAll(async () => {
  await pg.db.close();
});

const storedPublishedAt = async () =>
  (await pg.db.query<{ publishedAt: Date | null }>(`SELECT "publishedAt" FROM "Post" WHERE id = 5`))
    .rows[0].publishedAt;

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.db.exec(`TRUNCATE "Post"`);
  await pg.db.query(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (5, $1, NULL)`, [
    OWNER,
  ]);
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...(values as never[]));
    return pg.db.query(q.text, q.values as unknown[]);
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn(dbMock.dbWrite)) as never);
  dbMock.dbWrite.post.update.mockImplementation((async () => ({
    id: 5,
    userId: OWNER,
    publishedAt: await storedPublishedAt(),
  })) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
});

describe('post text scan triggers', () => {
  it('does not scan a draft text edit, and scans once the edited draft is scheduled', async () => {
    await updatePost({ id: 5, user: owner, title: 'Edited', detail: 'Edited detail' });
    expect(scanEntityInBackground).not.toHaveBeenCalled();

    await updatePost({ id: 5, user: owner, publishedAt: new Date(Date.now() + 86_400_000) });
    expect(await storedPublishedAt()).not.toBeNull();
    expect(scanEntityInBackground).toHaveBeenCalledTimes(1);
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Post', entityId: 5 });
  });

  it('scans a text edit on a scheduled post', async () => {
    await pg.db.exec(`UPDATE "Post" SET "publishedAt" = now() + interval '1 day' WHERE id = 5`);
    await updatePost({ id: 5, user: owner, detail: 'Edited detail' });
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Post', entityId: 5 });
  });
});
