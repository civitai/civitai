import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000 });

/**
 * A moderator unpublish records why on the post; the owner's republish has to clear it with the other
 * unpublish stamps, or a later unpublish reads as the moderator's again.
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

const { unpublishPostAsModerator, updatePost } = await import('~/server/services/post.service');

const OWNER = 10;
const MOD = 900;
const pg = { db: null as unknown as PGlite };

beforeAll(async () => {
  pg.db = await PGlite.create();
  await pg.db.exec(`
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "publishedAt" timestamp(3),
      metadata jsonb
    );
  `);
});

afterAll(async () => {
  await pg.db.close();
});

beforeEach(async () => {
  await pg.db.exec(`TRUNCATE "Post"`);
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
    publishedAt: null,
  })) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
});

describe('republishing a post a moderator unpublished', () => {
  it('clears the moderator unpublish reason with the other stamps', async () => {
    await pg.db.query(
      `INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (5, $1, now() - interval '1 day')`,
      [OWNER]
    );
    await unpublishPostAsModerator({ id: 5, userId: MOD, reason: 'csam-text-hold' });
    const before = (
      await pg.db.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM "Post" WHERE id = 5`
      )
    ).rows[0].metadata;
    expect(before.unpublishedReason).toBe('csam-text-hold');

    await updatePost({
      id: 5,
      user: { id: OWNER, isModerator: false } as SessionUser,
      publishedAt: new Date(),
    });

    const { rows } = await pg.db.query<{
      publishedAt: Date | null;
      metadata: Record<string, unknown>;
    }>(`SELECT "publishedAt", metadata FROM "Post" WHERE id = 5`);
    expect(rows[0].publishedAt).not.toBeNull();
    expect(rows[0].metadata).toEqual({});
  });
});
