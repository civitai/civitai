import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A ban blocks every image of the account not already Blocked, as 'moderated'. A CSAM block a failed
 * rescan left in Error keeps its reason: only a moderator's CSAM review re-labels it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { blockBannedUserImages } = await import('~/server/services/user.service');

const holder = { db: null as unknown as PGlite };
const BANNED = 7;
const OTHER_USER = 8;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      metadata jsonb,
      "updatedAt" timestamp(3)
    );
  `);
});

beforeEach(async () => {
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel") VALUES
      (1, ${BANNED}, 'Error', 'CSAM', 32),
      (2, ${BANNED}, 'Scanned', NULL, 1),
      (3, ${BANNED}, 'Blocked', 'tos', 32),
      (4, ${OTHER_USER}, 'Scanned', NULL, 1);
  `);
});

const rows = async () =>
  (
    await holder.db.query<{ id: number; ingestion: string; blockedFor: string | null }>(
      `SELECT id, ingestion, "blockedFor" FROM "Image" ORDER BY id`
    )
  ).rows;

describe('the ban media block', () => {
  it('blocks a CSAM row a failed rescan left in Error and keeps its reason', async () => {
    await blockBannedUserImages(BANNED);

    expect(await rows()).toEqual([
      { id: 1, ingestion: 'Blocked', blockedFor: 'CSAM' },
      // Control: any other unblocked image of the account is blocked as moderated.
      { id: 2, ingestion: 'Blocked', blockedFor: 'moderated' },
      // An existing block and another account are untouched.
      { id: 3, ingestion: 'Blocked', blockedFor: 'tos' },
      { id: 4, ingestion: 'Scanned', blockedFor: null },
    ]);
  });
});
