import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';

const { mockPreviewComFaceIntent, mockPreviewTextScanNsfw, mockBust } = vi.hoisted(() => ({
  mockPreviewComFaceIntent: vi.fn(),
  mockPreviewTextScanNsfw: vi.fn(),
  mockBust: vi.fn(),
}));

vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreviewComFaceIntent,
  previewTextScanNsfw: mockPreviewTextScanNsfw,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustPublicModelResponseCache: mockBust,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  COM_FACE_RESTORE_QUIET_MS,
  processComFaceRestores,
  queueComFaceRestore,
} from '~/server/services/model-com-face-recheck.service';

/**
 * A model whose .com face the listing re-check removed gets one intent check after its owner edits
 * the .red listing. The SQL runs against a real Postgres (PGlite), so "marker gone" is read back from
 * the row, not inferred from a call.
 */

const db = dbMock.dbWrite;
const MODEL_ID = 42;
const KEY = `com-face-restore:${MODEL_ID}`;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const quiet = new Date(NOW.getTime() + COM_FACE_RESTORE_QUIET_MS);
const MARKER = { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: 5, reason: 'detected' };
const intent = (detected: boolean) => ({ status: 'ok', output: { detected, reason: 'stub' } });

let pg: PGlite;
const run = async (sql: Prisma.Sql) => (await pg.query(sql.text, sql.values)).affectedRows ?? 0;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text, description text, "sfwCoverImageId" int, meta jsonb
    );
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb);
  `);
});
afterAll(() => pg.close());

async function seed({ marked = true, cover = null as number | null } = {}) {
  await pg.exec(`TRUNCATE "Model"; TRUNCATE "KeyValue";`);
  await pg.query(`INSERT INTO "Model" VALUES ($1, $2, $3, $4, $5::jsonb)`, [
    MODEL_ID,
    'Listing Title',
    '<p>Listing description</p>',
    cover,
    JSON.stringify(marked ? { other: 'kept', comFaceRemoved: MARKER } : { other: 'kept' }),
  ]);
  const read = async () => {
    const row = (
      await pg.query<{
        id: number;
        name: string;
        description: string | null;
        sfwCoverImageId: number | null;
        meta: Record<string, unknown>;
      }>(`SELECT * FROM "Model" WHERE id = $1`, [MODEL_ID])
    ).rows[0];
    return {
      ...row,
      userId: 101,
      sfwName: 'Retro Style',
      deletedAt: null,
    };
  };
  db.model.findUnique.mockImplementation((() => read()) as never);
}
const meta = async () =>
  (await pg.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM "Model"`)).rows[0].meta;
const restoreRows = async () => (await pg.query(`SELECT key FROM "KeyValue"`)).rows.length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.$executeRaw.mockImplementation(((sql: Prisma.Sql) => run(sql)) as never);
  db.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({ $executeRaw: (sql: Prisma.Sql) => run(sql), modActivity: db.modActivity })) as never);
  db.keyValue.findMany.mockImplementation(
    (async () => (await pg.query(`SELECT key, value FROM "KeyValue"`)).rows) as never
  );
  db.modelVersion.findMany.mockResolvedValue([{ name: 'v1', trainedWords: ['trigger'] }] as never);
  db.modActivity.create.mockResolvedValue({} as never);
  // The version names and trigger words rate PG.
  mockPreviewTextScanNsfw.mockResolvedValue({ status: 'ok', level: 1, reason: '' });
});
afterEach(() => {
  vi.useRealTimers();
});

/** An owner's .red edit, then the job once the burst has gone quiet. */
async function editThenRun() {
  await queueComFaceRestore(MODEL_ID);
  vi.setSystemTime(quiet);
  return processComFaceRestores(quiet);
}

describe('the .com face restore check', () => {
  it('drops the marker and logs it when the edited listing is allowed, leaving the cover unset', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    const counts = await editThenRun();

    expect(counts.restored).toBe(1);
    expect(await meta()).toEqual({ other: 'kept' });
    expect((await pg.query(`SELECT "sfwCoverImageId" FROM "Model"`)).rows[0]).toEqual({
      sfwCoverImageId: null,
    });
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: { activity: 'restoreComFace', entityType: 'model', entityId: MODEL_ID },
    });
    expect(await restoreRows()).toBe(0);
  });

  it('keeps the marker when the edited listing is still detected', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));

    const counts = await editThenRun();

    expect(counts.kept).toBe(1);
    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
    expect(db.modActivity.create).not.toHaveBeenCalled();
    expect(await restoreRows()).toBe(0);
  });

  it('keeps the marker while the version names or trigger words still rate mature', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));
    mockPreviewTextScanNsfw.mockResolvedValue({ status: 'ok', level: 4, reason: '' });

    const counts = await editThenRun();

    expect(counts.kept).toBe(1);
    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });

  it('keeps the marker when the version rating gives no verdict', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));
    mockPreviewTextScanNsfw.mockResolvedValue({ status: 'unavailable' });

    const counts = await editThenRun();

    expect(counts.unavailable).toBe(1);
    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
  });

  it('keeps the marker when the check gives no verdict', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await editThenRun();

    expect(counts.unavailable).toBe(1);
    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
  });

  it('never calls the check for a model without the marker', async () => {
    await seed({ marked: false });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    await queueComFaceRestore(MODEL_ID);
    expect(await restoreRows()).toBe(0);

    // Armed anyway, as by an edit that raced the marker being dropped.
    await pg.query(`INSERT INTO "KeyValue" VALUES ($1, $2::jsonb)`, [
      KEY,
      JSON.stringify({ editAt: NOW.toISOString() }),
    ]);
    await processComFaceRestores(quiet);
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
  });

  it('checks once per burst of edits, after the owner stops', async () => {
    await seed();
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));

    await queueComFaceRestore(MODEL_ID);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await queueComFaceRestore(MODEL_ID);
    // Quiet since the first edit, but not since the second.
    await processComFaceRestores(quiet);
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();

    const later = new Date(NOW.getTime() + 60_000 + COM_FACE_RESTORE_QUIET_MS);
    await processComFaceRestores(later);
    await processComFaceRestores(later);
    expect(mockPreviewComFaceIntent).toHaveBeenCalledTimes(1);
  });

  it('keeps the marker when a cover was picked since the read', async () => {
    await seed();
    mockPreviewComFaceIntent.mockImplementation(async () => {
      await pg.exec(`UPDATE "Model" SET "sfwCoverImageId" = 9`);
      return intent(false);
    });

    const counts = await editThenRun();

    expect(counts.skipped).toBe(1);
    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });

  it('keeps an edit that lands during the check for its own check', async () => {
    await seed();
    mockPreviewComFaceIntent.mockImplementation(async () => {
      vi.setSystemTime(new Date(quiet.getTime() + 1000));
      await queueComFaceRestore(MODEL_ID);
      return intent(true);
    });

    await editThenRun();

    expect(await restoreRows()).toBe(1);
  });

  it.each(['name', 'description'])(
    'keeps the marker when the owner edits the %s while an allowed check is out',
    async (column) => {
      await seed();
      mockPreviewComFaceIntent.mockImplementation(async () => {
        await pg.exec(`UPDATE "Model" SET ${column} = 'newer text'`);
        return intent(false);
      });

      const counts = await editThenRun();

      expect(counts.skipped).toBe(1);
      expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
    }
  );

  it('keeps the marker when a trigger-word edit is armed while an allowed check is out', async () => {
    await seed();
    mockPreviewComFaceIntent.mockImplementation(async () => {
      vi.setSystemTime(new Date(quiet.getTime() + 1000));
      await queueComFaceRestore(MODEL_ID);
      return intent(false);
    });

    await editThenRun();

    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: MARKER });
    expect(await restoreRows()).toBe(1);
  });

  it('keeps a newer removal that lands while an allowed check is out', async () => {
    await seed();
    const newer = { ...MARKER, at: '2026-11-05T12:00:30.000Z' };
    mockPreviewComFaceIntent.mockImplementation(async () => {
      await pg.query(`UPDATE "Model" SET meta = $1::jsonb`, [
        JSON.stringify({ other: 'kept', comFaceRemoved: newer }),
      ]);
      return intent(false);
    });

    await editThenRun();

    expect(await meta()).toEqual({ other: 'kept', comFaceRemoved: newer });
  });
});
