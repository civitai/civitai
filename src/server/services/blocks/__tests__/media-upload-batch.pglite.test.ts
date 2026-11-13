import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The batch bounds as the database enforces them: the hand-applied migration itself is loaded into
 * PGlite, and the service's own conditional UPDATEs run against it. The orchestrator presign is a
 * spy. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { presignSpy } = vi.hoisted(() => ({ presignSpy: vi.fn() }));
vi.mock('~/server/services/orchestrator/consumerBlobUpload', () => ({
  getConsumerBlobUploadUrlService: (...a: unknown[]) => presignSpy(...a),
}));

const { presignMediaUploadBatchItem, recordMediaUploadBatchItem } = await import(
  '~/server/services/blocks/media-upload-batch.service'
);

const MIGRATION = join(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20270102120000_app_block_upload_batches/migration.sql'
);
const USER = 42;
const ACTOR = { userId: USER, appBlockId: 'apb_alpha' };
const NOW = new Date('2026-11-11T10:00:00.000Z');
const KEY_A = `${'0123456789abcdef'.repeat(2)}.jpeg`;
const KEY_B = `${'fedcba9876543210'.repeat(2)}.jpeg`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});
afterAll(async () => {
  await db.close();
});

/** A fresh batch of `itemCount` declared files, started at `createdAt`; returns its id. */
async function batch(itemCount: number, createdAt = NOW, user = USER): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO app_block_upload_batches
       (user_id, app_block_id, app_id, block_id, item_count, total_bytes, presign_counts,
        created_at, expires_at)
     VALUES ($1, 'apb_alpha', 'app_alpha', 'alpha-app', $2, 1000, array_fill(0, ARRAY[$2::int]),
             $3, $3::timestamptz + interval '30 days')
     RETURNING id`,
    [user, itemCount, createdAt.toISOString()]
  );
  return rows[0].id;
}

beforeEach(async () => {
  await db.exec('DELETE FROM app_block_upload_batches');
  presignSpy.mockReset().mockResolvedValue({ uploadUrl: 'u', expiresAt: 'e' });
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(raw.queryRaw);
  dbMock.dbWrite.$executeRaw.mockReset().mockImplementation(raw.executeRaw);
});

const presign = (batchId: number, index: number, actor = ACTOR, now = NOW) =>
  presignMediaUploadBatchItem({ actor, batchId, index, token: 'viewer-token', now });

describe('presign: at most two upload URLs per declared file', () => {
  it('a file’s third URL is refused while another file still gets its own', async () => {
    const id = await batch(2);
    await expect(presign(id, 0)).resolves.toEqual({ uploadUrl: 'u', expiresAt: 'e' });
    await expect(presign(id, 0)).resolves.toBeDefined();
    await expect(presign(id, 0)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this batch cannot take more uploads',
    });
    await expect(presign(id, 1)).resolves.toBeDefined();
    expect(presignSpy).toHaveBeenCalledTimes(3);
  });

  it('a position past the files the batch declared is refused', async () => {
    const id = await batch(2);
    await expect(presign(id, 2)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(presignSpy).not.toHaveBeenCalled();
  });

  it('a mint that fails hands that file’s attempt back', async () => {
    const id = await batch(1);
    presignSpy.mockRejectedValueOnce(new Error('upstream 503'));
    await expect(presign(id, 0)).rejects.toThrow('upstream 503');
    await expect(presign(id, 0)).resolves.toBeDefined();
    await expect(presign(id, 0)).resolves.toBeDefined();
    await expect(presign(id, 0)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { rows } = await db.query<{ presign_count: number; presign_counts: number[] }>(
      'SELECT presign_count, presign_counts FROM app_block_upload_batches WHERE id = $1',
      [id]
    );
    expect(rows[0]).toEqual({ presign_count: 2, presign_counts: [2] });
  });

  it.each([
    ['another viewer', { userId: USER + 1, appBlockId: 'apb_alpha' }, NOW],
    ['another app', { userId: USER, appBlockId: 'apb_beta' }, NOW],
    ['a batch past its 6 h open window', ACTOR, new Date('2026-11-11T16:00:01.000Z')],
  ])('is refused for %s', async (_label, actor, now) => {
    const id = await batch(2);
    await expect(presign(id, 0, actor, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(presignSpy).not.toHaveBeenCalled();
  });
});

describe('record: one key per declared file, no repeats', () => {
  const record = (batchId: number, blobKey: string) =>
    recordMediaUploadBatchItem({ actor: ACTOR, batchId, blobKey, now: NOW });

  it('appends keys up to the file count, refusing a repeat and the one past the count', async () => {
    const id = await batch(1);
    await expect(record(id, KEY_A)).resolves.toEqual({
      expiresAt: new Date('2026-12-11T10:00:00.000Z'),
    });
    await expect(record(id, KEY_A)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(record(id, KEY_B)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { rows } = await db.query<{ blob_keys: string[] }>(
      'SELECT blob_keys FROM app_block_upload_batches WHERE id = $1',
      [id]
    );
    expect(rows[0].blob_keys).toEqual([KEY_A]);
  });
});
