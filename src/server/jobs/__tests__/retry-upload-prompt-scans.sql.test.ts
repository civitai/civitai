import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loadRetryImages } from '~/server/jobs/retry-upload-prompt-scans';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      meta jsonb,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
    );
  `);
});

beforeEach(async () => {
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  await holder.db.exec(`TRUNCATE "Image"`);
});

const insert = (id: number, nsfwLevel: number, ingestion = 'Scanned') =>
  holder.db.query(
    `INSERT INTO "Image" (id, "userId", meta, "nsfwLevel", ingestion) VALUES ($1, 7, $2, $3, $4)`,
    [id, { prompt: `prompt ${id}`, negativePrompt: 'neg' }, nsfwLevel, ingestion]
  );

describe('loadRetryImages', () => {
  it('returns the images still due a scan, with their prompts, and none blocked or below R', async () => {
    await insert(1, 4); // R
    await insert(2, 8); // X
    await insert(3, 16); // XXX
    await insert(4, 2); // PG13
    await insert(5, 1); // PG
    await insert(6, 8, 'Blocked');
    await insert(7, 32, 'Blocked');

    const rows = await loadRetryImages([1, 2, 3, 4, 5, 6, 7, 99]);

    expect(rows.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.id === 1)).toEqual({
      id: 1,
      userId: 7,
      prompt: 'prompt 1',
      negativePrompt: 'neg',
    });
  });
});
