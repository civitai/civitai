import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The pending query runs for real: a row backing off must drop out of the window until its time,
// then come back, so it can neither be lost nor crowd newer rows out.

const { getPendingStudioDatasetFileIds } = await import(
  '~/server/services/orchestrator/training/studio-dataset-archive.service'
);

const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "ModelFile" (id int PRIMARY KEY, type text, url text, "sizeKB" float8, metadata jsonb);
  `);
});
afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`DELETE FROM "ModelFile"`);
  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

const EPOCH_URL = 'https://orch.example/e';
async function seed(id: number, metadata: Record<string, unknown>, sizeKB = 0, url = EPOCH_URL) {
  await db.pg.query(
    `INSERT INTO "ModelFile" (id, type, url, "sizeKB", metadata) VALUES ($1, 'Training Data', $2, $3, $4::jsonb)`,
    [id, url, sizeKB, JSON.stringify({ selectedEpochUrl: EPOCH_URL, ...metadata })]
  );
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('getPendingStudioDatasetFileIds', () => {
  it('skips a row backing off until its retry time, then returns it', async () => {
    await seed(1, {});
    await seed(2, { datasetArchiveRetryAfter: hoursFromNow(2), datasetArchiveServiceAttempts: 2 });
    await seed(3, { datasetArchiveRetryAfter: hoursFromNow(-1), datasetArchiveServiceAttempts: 1 });
    await seed(4, { datasetArchive: { status: 'archived' } });
    await seed(5, {}, 1234);

    expect(await getPendingStudioDatasetFileIds(25)).toEqual([3, 1]);
  });

  it('fills the window from the rows that are due, past any backing off', async () => {
    for (let id = 10; id < 15; id++) await seed(id, { datasetArchiveRetryAfter: hoursFromNow(5) });
    await seed(1, { datasetArchiveAttempts: 1 });

    expect(await getPendingStudioDatasetFileIds(2)).toEqual([1]);
  });

  it('never returns a file the owner uploaded in place of the placeholder, even at size 0', async () => {
    await seed(1, {});
    await seed(2, {}, 0, 'https://storage.example/training-images/5/owner-data.zip');

    expect(await getPendingStudioDatasetFileIds(25)).toEqual([1]);
  });
});
