import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: null,
}));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const { copyScanLabelImages, scanLabelCopyStoreFromEnv } = await import(
  '~/server/jobs/scan-label-copy'
);

const MIGRATIONS = [
  '20261022130000_scan_label_queue',
  '20261022140000_scan_label_outcomes',
  '20261023130000_scan_label_reasons_copy',
  '20261023140000_scan_label_copy_sweep',
  '20261024130000_scan_label_copy_removed_at',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
);

// The real eligibility view is applied separately and is not in this repository. This stand-in
// reads a test table, so each case states eligibility directly.
const STAND_IN_VIEW = `
  CREATE TABLE test_eligibility ("itemId" integer PRIMARY KEY, ok boolean NOT NULL);
  CREATE VIEW "ScanLabelCopyEligibility" AS
    SELECT "itemId", ok AS "eligibleForCopy" FROM test_eligibility;
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL DEFAULT 7,
      "url" text NOT NULL,
      "pHash" bigint,
      "blockedFor" text,
      "needsReview" text
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
  await holder.db.exec(STAND_IN_VIEW);
});

beforeEach(async () => {
  vi.mocked(loggingMock.logToAxiom).mockClear();
  await holder.db.exec(`TRUNCATE "ScanLabelItem", "Image", "CsamReport", test_eligibility CASCADE`);
});

/** A decided item for image `imageId` (item id = image id), with its eligibility row. */
async function decided(
  imageId: number,
  { eligible, daysAgo = 0.1 }: { eligible: boolean | null; daysAgo?: number }
) {
  await holder.db.query(`INSERT INTO "Image" ("id", "url") VALUES ($1, $2)`, [
    imageId,
    `key-${imageId}`,
  ]);
  await holder.db.query(
    `INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt", "status", "votes", "outcome", "decidedAt")
     VALUES ($1, $1, now(), 'decided', 3, 'clear', now() - make_interval(secs => $2))`,
    [imageId, daysAgo * 86400]
  );
  if (eligible !== null)
    await holder.db.query(`INSERT INTO test_eligibility VALUES ($1, $2)`, [imageId, eligible]);
}

const state = async () =>
  (
    await holder.db.query<{ id: number; copyState: string | null; copyKey: string | null }>(
      `SELECT id, "copyState", "copyKey" FROM "ScanLabelItem" ORDER BY id`
    )
  ).rows;

const recordingStore = () => {
  const puts: [string, string][] = [];
  return { puts, store: { put: async (url: string, key: string) => void puts.push([url, key]) } };
};

describe('copyScanLabelImages', () => {
  it('never copies an item the eligibility view excludes, or one it does not list', async () => {
    await decided(1, { eligible: true });
    await decided(2, { eligible: false });
    await decided(3, { eligible: null });
    const { puts, store } = recordingStore();

    expect(await copyScanLabelImages({ store })).toMatchObject({ copied: 1, skipped: 2 });
    expect(puts).toEqual([['key-1', '1/key-1']]);
    expect(await state()).toEqual([
      { id: 1, copyState: 'copied', copyKey: '1/key-1' },
      { id: 2, copyState: 'skipped', copyKey: null },
      { id: 3, copyState: 'skipped', copyKey: null },
    ]);
  });

  it('copies each item once', async () => {
    await decided(1, { eligible: true });
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    await copyScanLabelImages({ store });
    expect(puts).toHaveLength(1);
  });

  it('never copies an image in the CSAM path, even when the view allows it', async () => {
    await decided(1, { eligible: true });
    await decided(2, { eligible: true });
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    await holder.db.exec(
      `INSERT INTO "CsamReport" ("userId", "images") VALUES (99, '[{"id": 2}]')`
    );
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    expect(puts).toEqual([]);
  });

  it('never copies a stored object another image in the CSAM path shares', async () => {
    await decided(1, { eligible: true });
    await holder.db.exec(
      `INSERT INTO "Image" ("id", "url", "needsReview") VALUES (50, 'key-1', 'csam')`
    );
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    expect(puts).toEqual([]);
    expect((await state())[0].copyState).toBe('skipped');
  });

  it('skips an item decided before the originals are purged', async () => {
    await decided(1, { eligible: true, daysAgo: 7 });
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    expect(puts).toEqual([]);
    expect((await state())[0].copyState).toBe('skipped');
  });

  it('ignores items still being voted on', async () => {
    await decided(1, { eligible: true });
    await holder.db.exec(`UPDATE "ScanLabelItem" SET status = 'open' WHERE id = 1`);
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    expect(puts).toEqual([]);
    expect((await state())[0].copyState).toBeNull();
  });

  it('marks a failed copy and retries it next run', async () => {
    await decided(1, { eligible: true });
    const failing = {
      put: async () => {
        throw new Error('b2 down');
      },
    };
    expect(await copyScanLabelImages({ store: failing })).toMatchObject({ failed: 1 });
    expect((await state())[0].copyState).toBe('failed');
    const { puts, store } = recordingStore();
    await copyScanLabelImages({ store });
    expect(puts).toHaveLength(1);
    expect((await state())[0].copyState).toBe('copied');
  });

  it('copies and marks nothing when the eligibility view is missing', async () => {
    await decided(1, { eligible: true });
    await holder.db.exec(`DROP VIEW "ScanLabelCopyEligibility"`);
    try {
      const { puts, store } = recordingStore();
      expect(await copyScanLabelImages({ store })).toEqual({
        configured: true,
        eligibility: false,
      });
      expect(puts).toEqual([]);
      expect((await state())[0].copyState).toBeNull();
    } finally {
      await holder.db.exec(STAND_IN_VIEW.replace(/CREATE TABLE[^;]*;/, ''));
    }
  });

  it('does nothing, with one warning, when the bucket is not configured', async () => {
    setEnv({ SCAN_LABEL_P3_B2_BUCKET: undefined });
    expect(await scanLabelCopyStoreFromEnv()).toBeNull();
    await decided(1, { eligible: true });
    expect(await copyScanLabelImages()).toEqual({ configured: false });
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'scan-label-copy' })
    );
    expect((await state())[0].copyState).toBeNull();
  });
});
