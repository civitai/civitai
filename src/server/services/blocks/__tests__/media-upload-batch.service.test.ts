import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `media-upload-batch.service` — the server half of `OPEN_MEDIA_UPLOAD_BATCH`: the viewer's daily
 * batch quota, the audit row, the user-token presign and the per-file record. Redis is an
 * in-memory counter here, so the quota is measured at its real boundaries; the orchestrator presign
 * is a spy, so what it is called WITH is the assertion.
 */

const { presignSpy } = vi.hoisted(() => ({ presignSpy: vi.fn() }));
vi.mock('~/server/services/orchestrator/consumerBlobUpload', () => ({
  getConsumerBlobUploadUrlService: (...a: unknown[]) => presignSpy(...a),
}));

const {
  presignMediaUploadBatchItem,
  recordMediaUploadBatchItem,
  reserveMediaUploadBatchQuota,
  startMediaUploadBatch,
} = await import('~/server/services/blocks/media-upload-batch.service');

const USER = 42;
const ACTOR = { userId: USER, appBlockId: 'apb_alpha', appId: 'app_alpha', blockId: 'alpha-app' };
const NOW = new Date('2026-11-11T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const counters = new Map<string, number>();
const missingTable = () =>
  Object.assign(
    new Error(
      'The table `public.app_block_upload_batches` does not exist in the current database.'
    ),
    { code: 'P2021' }
  );

beforeEach(() => {
  counters.clear();
  presignSpy.mockReset().mockResolvedValue({ uploadUrl: 'u', expiresAt: 'e' });
  redisMock.sysRedis.incrBy.mockReset().mockImplementation(async (key: string, n: number) => {
    const next = (counters.get(key) ?? 0) + n;
    counters.set(key, next);
    return next;
  });
  redisMock.sysRedis.decrBy.mockReset().mockImplementation(async (key: string, n: number) => {
    const next = (counters.get(key) ?? 0) - n;
    counters.set(key, next);
    return next;
  });
  redisMock.sysRedis.expire.mockReset().mockResolvedValue(true);
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({ version: '1.4.0' });
  dbMock.dbWrite.appBlockUploadBatch.create.mockReset().mockResolvedValue({ id: 91 });
  dbMock.dbWrite.$queryRaw.mockReset().mockResolvedValue([{ id: 91 }]);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
});

const items = (n: number, sizeBytes = 1000) =>
  Array.from({ length: n }, () => ({ kind: 'image' as const, sizeBytes }));

/** The sum of every counter whose key names `part` — items or bytes — for `USER`. */
const used = (part: 'items' | 'bytes') =>
  [...counters.entries()]
    .filter(([k]) => k.includes(`:${part}:${USER}:`))
    .reduce((s, [, v]) => s + v, 0);

describe('the daily batch quota', () => {
  it('admits the 1,200th file of the day and refuses the 1,201st', async () => {
    await expect(reserveMediaUploadBatchQuota(USER, 1199, 10, NOW)).resolves.toBeTypeOf('function');
    await expect(reserveMediaUploadBatchQuota(USER, 1, 10, NOW)).resolves.toBeTypeOf('function');
    await expect(reserveMediaUploadBatchQuota(USER, 1, 10, NOW)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message:
        "You've reached today's batch upload limit (1,200 files or 10 GB). It resets at midnight UTC.",
    });
    // The refused charge was handed back: the day still reads exactly 1,200.
    expect(used('items')).toBe(1200);
  });

  it('admits 10 GiB in a day and refuses one byte more', async () => {
    // 10 GiB = 10,737,418,240 bytes; the first charge alone is above the old 5 GiB cap.
    await reserveMediaUploadBatchQuota(USER, 1, 6_442_450_944, NOW);
    await reserveMediaUploadBatchQuota(USER, 1, 4_294_967_295, NOW);
    await reserveMediaUploadBatchQuota(USER, 1, 1, NOW);
    await expect(reserveMediaUploadBatchQuota(USER, 1, 1, NOW)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(used('bytes')).toBe(10_737_418_240);
    expect(used('items')).toBe(3);
  });

  it('is per UTC day: a new day starts from zero', async () => {
    await reserveMediaUploadBatchQuota(USER, 1200, 10, NOW);
    const tomorrow = new Date(NOW.getTime() + DAY_MS);
    await expect(reserveMediaUploadBatchQuota(USER, 1200, 10, tomorrow)).resolves.toBeTypeOf(
      'function'
    );
  });

  it('is per viewer, across apps: another viewer is unaffected', async () => {
    await reserveMediaUploadBatchQuota(USER, 1200, 10, NOW);
    await expect(reserveMediaUploadBatchQuota(USER + 1, 1200, 10, NOW)).resolves.toBeTypeOf(
      'function'
    );
  });

  it('fails closed when the counter cannot be written, charging nothing', async () => {
    redisMock.sysRedis.incrBy
      .mockImplementationOnce(async (key: string, n: number) => {
        counters.set(key, (counters.get(key) ?? 0) + n);
        return counters.get(key)!;
      })
      .mockRejectedValueOnce(new Error('sysredis down'));
    await expect(reserveMediaUploadBatchQuota(USER, 5, 10, NOW)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(used('items')).toBe(0);
  });
});

describe('startMediaUploadBatch', () => {
  it('writes the audit row with the token’s app identity and expires_at = start + 30 days', async () => {
    const out = await startMediaUploadBatch({ actor: ACTOR, items: items(3, 2000), now: NOW });
    const expiresAt = new Date('2026-12-11T10:00:00.000Z');
    expect(out).toEqual({ batchId: 91, expiresAt });
    expect(dbMock.dbWrite.appBlockUploadBatch.create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        appBlockId: 'apb_alpha',
        appId: 'app_alpha',
        blockId: 'alpha-app',
        version: '1.4.0',
        itemCount: 3,
        presignCounts: [0, 0, 0],
        totalBytes: BigInt(6000),
        createdAt: NOW,
        expiresAt,
      },
      select: { id: true },
    });
    expect(used('items')).toBe(3);
    expect(used('bytes')).toBe(6000);
  });

  it('a batch over the quota is refused before any row is written', async () => {
    await expect(
      startMediaUploadBatch({ actor: ACTOR, items: items(1201), now: NOW })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(dbMock.dbWrite.appBlockUploadBatch.create).not.toHaveBeenCalled();
  });

  it('records a NULL version for an app with no AppBlock row', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    await startMediaUploadBatch({ actor: ACTOR, items: items(1), now: NOW });
    expect(dbMock.dbWrite.appBlockUploadBatch.create.mock.calls[0][0].data.version).toBeNull();
  });

  it('before the audit table exists: a clear refusal, never a 500, and the quota handed back', async () => {
    dbMock.dbWrite.appBlockUploadBatch.create.mockRejectedValue(missingTable());
    await expect(
      startMediaUploadBatch({ actor: ACTOR, items: items(4), now: NOW })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'batch media upload is not available yet, please try again later',
    });
    expect(used('items')).toBe(0);
    expect(used('bytes')).toBe(0);
  });

  it.each([
    [
      'a raw-query permission error',
      Object.assign(
        new Error(
          'Raw query failed. Code: `42501`. Message: `permission denied for table app_block_upload_batches`'
        ),
        { code: 'P2010', meta: { code: '42501' } }
      ),
    ],
    [
      'a permission error on the id sequence',
      new Error('permission denied for sequence app_block_upload_batches_id_seq'),
    ],
  ])(
    'with the table applied but not granted (%s): the same clean refusal, and the quota handed back',
    async (_label, err) => {
      dbMock.dbWrite.appBlockUploadBatch.create.mockRejectedValue(err);
      await expect(
        startMediaUploadBatch({ actor: ACTOR, items: items(2), now: NOW })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'batch media upload is not available yet, please try again later',
      });
      expect(used('items')).toBe(0);
    }
  );

  it('a permission error on ANOTHER table is not dressed up as "not available"', async () => {
    dbMock.dbWrite.appBlockUploadBatch.create.mockRejectedValue(
      new Error('permission denied for table "User"')
    );
    await expect(
      startMediaUploadBatch({ actor: ACTOR, items: items(1), now: NOW })
    ).rejects.toThrow('permission denied for table "User"');
  });

  it('any other write failure is not dressed up as "not available"', async () => {
    dbMock.dbWrite.appBlockUploadBatch.create.mockRejectedValue(new Error('connection reset'));
    await expect(
      startMediaUploadBatch({ actor: ACTOR, items: items(1), now: NOW })
    ).rejects.toThrow('connection reset');
    expect(used('items')).toBe(0);
  });
});

describe('presignMediaUploadBatchItem', () => {
  it('mints the URL with the VIEWER’s token it was handed, after claiming an attempt', async () => {
    await expect(
      presignMediaUploadBatchItem({
        actor: ACTOR,
        batchId: 91,
        index: 0,
        token: 'viewer-token',
        now: NOW,
      })
    ).resolves.toEqual({ uploadUrl: 'u', expiresAt: 'e' });
    expect(presignSpy.mock.calls).toEqual([[{ token: 'viewer-token' }]]);
    // Which attempts the claim admits is measured against real SQL in the pglite suite.
  });

  it('refuses, and mints nothing, once the batch has no attempts left (or is not this viewer’s)', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(
      presignMediaUploadBatchItem({
        actor: ACTOR,
        batchId: 91,
        index: 0,
        token: 'viewer-token',
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'this batch cannot take more uploads' });
    expect(presignSpy).not.toHaveBeenCalled();
  });

  it('hands the attempt back when the orchestrator mints nothing', async () => {
    presignSpy.mockRejectedValue(new Error('upstream 503'));
    await expect(
      presignMediaUploadBatchItem({
        actor: ACTOR,
        batchId: 91,
        index: 0,
        token: 'viewer-token',
        now: NOW,
      })
    ).rejects.toThrow('upstream 503');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('before the audit table exists: the not-available refusal', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(missingTable());
    await expect(
      presignMediaUploadBatchItem({
        actor: ACTOR,
        batchId: 91,
        index: 0,
        token: 'viewer-token',
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(presignSpy).not.toHaveBeenCalled();
  });
});

describe('recordMediaUploadBatchItem', () => {
  const KEY = `${'0123456789abcdef'.repeat(2)}.jpeg`;

  it('appends the key and returns the batch’s expiry', async () => {
    const expiresAt = new Date('2026-12-11T10:00:00.000Z');
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ expires_at: expiresAt }]);
    await expect(
      recordMediaUploadBatchItem({ actor: ACTOR, batchId: 91, blobKey: KEY, now: NOW })
    ).resolves.toEqual({ expiresAt });
    expect(dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1)).toEqual([
      KEY,
      91,
      USER,
      'apb_alpha',
      new Date(NOW.getTime() - 6 * 60 * 60 * 1000),
      KEY,
    ]);
  });

  it.each(['../etc/passwd', 'a/b/c/d/e/f/g/h', 'short', ''])(
    'refuses a key that is not one path segment (%s) without touching the row',
    async (blobKey) => {
      await expect(
        recordMediaUploadBatchItem({ actor: ACTOR, batchId: 91, blobKey, now: NOW })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    }
  );

  it('refuses past the batch’s file count (the UPDATE matched nothing)', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(
      recordMediaUploadBatchItem({ actor: ACTOR, batchId: 91, blobKey: KEY, now: NOW })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'this batch cannot record more files' });
  });
});
