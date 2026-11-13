import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

/**
 * `unpublishArticleById` against a real Postgres `Article` row, when a block moved the row to
 * UnpublishedViolation after the author's request first looked at it. Any read outside the
 * transaction (the replica, or a read before the block committed) still says Published. PGlite
 * has one connection, so this pins that the check reads inside the transaction, not the row lock
 * itself. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: {
      ...actual.userArticleCountCache,
      refresh: vi.fn(async () => undefined),
    },
  };
});

const { unpublishArticleById } = await import('~/server/services/article.service');

const ARTICLE = 31;
const AUTHOR = 8;
const PUBLISHED_AT = new Date('2026-01-01T00:00:00Z');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ArticleStatus" AS ENUM
      ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
    CREATE TABLE "Article" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "publishedAt" timestamp(3),
      status "ArticleStatus" NOT NULL,
      metadata jsonb
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  // Prisma's `update({ where: { id } })`, written through to the row.
  dbMock.dbWrite.article.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: { status: ArticleStatus; metadata: object };
  }) => {
    const { rows } = await db.query(
      `UPDATE "Article" SET status = $1, metadata = $2 WHERE id = $3 RETURNING *`,
      [data.status, JSON.stringify(data.metadata), where.id]
    );
    return rows[0];
  }) as never);
  // What a read from before the block, or from a lagging replica, returns.
  const stale = { userId: AUTHOR, publishedAt: PUBLISHED_AT, status: ArticleStatus.Published };
  dbMock.dbWrite.article.findUnique.mockResolvedValue(stale as never);
  dbMock.dbRead.article.findUnique.mockResolvedValue(stale as never);

  await db.query(`DELETE FROM "Article"`);
});

const seed = (status: ArticleStatus, metadata: object = {}) =>
  db.query(
    `INSERT INTO "Article" (id, "userId", "publishedAt", status, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [ARTICLE, AUTHOR, PUBLISHED_AT, status, JSON.stringify(metadata)]
  );

const row = async () =>
  (
    await db.query<{ status: string; metadata: Record<string, unknown> }>(
      `SELECT status, metadata FROM "Article" WHERE id = ${ARTICLE}`
    )
  ).rows[0];

describe('an author unpublishing an article', () => {
  it('unpublishes a published article', async () => {
    await seed(ArticleStatus.Published);
    await unpublishArticleById({ id: ARTICLE, userId: AUTHOR });
    expect(await row()).toMatchObject({
      status: 'Unpublished',
      metadata: { unpublishedBy: AUTHOR },
    });
  });

  // A moderator's restore of an Unpublished article requires a non-author `unpublishedBy`.
  it('records the moderator as the unpublisher when a moderator unpublishes it', async () => {
    await seed(ArticleStatus.Published);
    await unpublishArticleById({ id: ARTICLE, userId: 99, isModerator: true });
    expect(await row()).toMatchObject({ status: 'Unpublished', metadata: { unpublishedBy: 99 } });
  });

  it('leaves the block standing when one landed after the request first read the article', async () => {
    await seed(ArticleStatus.UnpublishedViolation, { unpublishedReason: 'tos', unpublishedBy: 1 });
    await expect(unpublishArticleById({ id: ARTICLE, userId: AUTHOR })).rejects.toThrow(
      'Article is not published'
    );
    expect(await row()).toEqual({
      status: 'UnpublishedViolation',
      metadata: { unpublishedReason: 'tos', unpublishedBy: 1 },
    });
  });
});
