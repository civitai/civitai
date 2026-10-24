import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticPhashService from '~/server/services/cosmetic-phash.service';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    queryRaw: vi.fn(),
    getPerceptualHash: vi.fn(),
    storeCosmeticPerceptualHash: vi.fn(),
    markCosmeticHashFailed: vi.fn(),
  },
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  getPerceptualHash: mocks.getPerceptualHash,
}));
vi.mock('~/server/services/cosmetic-phash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPhashService>()),
  storeCosmeticPerceptualHash: mocks.storeCosmeticPerceptualHash,
  markCosmeticHashFailed: mocks.markCosmeticHashFailed,
}));
import { COSMETIC_PHASH_LANE } from '~/server/services/cosmetic-phash.service';
import { sweepCosmeticPerceptualHashes } from '../cosmetic-phash-sweep';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.$queryRaw.mockImplementation((...args: unknown[]) =>
  (mocks.queryRaw as (...a: unknown[]) => unknown)(...args)
);

describe('sweepCosmeticPerceptualHashes', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.storeCosmeticPerceptualHash.mockResolvedValue(undefined);
    mocks.markCosmeticHashFailed.mockResolvedValue(undefined);
  });

  it('stores what it hashed, in the lane it asked for', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 11, url: 'artwork-11' }]);
    mocks.getPerceptualHash.mockResolvedValue('a6e0c4c4cce8a4b6');

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 1, hashed: 1, failed: 0 });
    expect(mocks.getPerceptualHash).toHaveBeenCalledWith(
      'artwork-11',
      COSMETIC_PHASH_LANE.hashType
    );
    expect(mocks.storeCosmeticPerceptualHash).toHaveBeenCalledWith({
      id: 11,
      url: 'artwork-11',
      hex: 'a6e0c4c4cce8a4b6',
    });
  });

  it('stamps an attempt that produced no hash, so dead artwork cannot starve the queue', async () => {
    // Three cosmetics point at CDN objects that no longer exist and can never be
    // hashed. Without the stamp they match the sweep predicate on every tick,
    // forever, ahead of rows that would succeed — and nothing reports it, because
    // "no hash yet" is not an error.
    mocks.queryRaw.mockResolvedValue([{ id: 240, url: 'gone' }]);
    mocks.getPerceptualHash.mockResolvedValue(undefined);

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 1, hashed: 0, failed: 1 });
    expect(mocks.markCosmeticHashFailed).toHaveBeenCalledWith(240);
    expect(mocks.storeCosmeticPerceptualHash).not.toHaveBeenCalled();
  });

  it('keeps going after a throw instead of losing the whole batch', async () => {
    mocks.queryRaw.mockResolvedValue([
      { id: 1, url: 'a' },
      { id: 2, url: 'b' },
      { id: 3, url: 'c' },
    ]);
    mocks.getPerceptualHash
      .mockResolvedValueOnce('0000000000000001')
      .mockRejectedValueOnce(new Error('orchestrator 503'))
      .mockResolvedValueOnce('0000000000000003');

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 3, hashed: 2, failed: 1 });
    expect(mocks.markCosmeticHashFailed).toHaveBeenCalledWith(2);
  });

  // The tick's `failed` tally cannot say WHY a row failed — dead CDN artwork, an
  // orchestrator still working when the wait elapsed, and a hash the store
  // refused for disagreeing with the lane all land in it identically, and the
  // operator's next move differs for each. This per-row log is the only thing
  // that separates them, so it has to be asserted: without it the catch is a
  // silent path again, which is the failure this whole area keeps producing.
  it('names the row and the reason when a store is refused, not just the tally', async () => {
    loggingMock.logToAxiom.mockClear();
    mocks.queryRaw.mockResolvedValue([{ id: 7, url: 'artwork-7' }]);
    mocks.getPerceptualHash.mockResolvedValue('a'.repeat(64));
    mocks.storeCosmeticPerceptualHash.mockRejectedValue(
      new Error('Hash is wider than lane perceptualDct256/256: 128 > 64')
    );

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 1, hashed: 0, failed: 1 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'cosmetic-phash-sweep',
        message: expect.stringContaining('7'),
        error: expect.stringContaining('wider than lane'),
      })
    );
  });

  it('selects on the version as well as the url, which is what drains a lane upgrade', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await sweepCosmeticPerceptualHashes();

    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    const sql = (strings as unknown as string[]).join('?');
    expect(sql).toContain('"pHashVersion" IS DISTINCT FROM');
    expect(sql).toContain('"pHashUrl" IS DISTINCT FROM');
    expect(sql).toContain('"pHashFailedAt" ASC NULLS FIRST');
    expect(values).toContain(COSMETIC_PHASH_LANE.version);
  });

  // The retry window and the lane predicate are ANDed, so the window is capable of
  // blocking the very drain a lane bump is meant to start. It doesn't, only because
  // `pHashFailedAt` is written on failure alone. This pins the suppression to the
  // failure column, so a future "stamp every attempt" change has to come past a
  // named assertion rather than silently costing a day of drain.
  it('gates the retry window on the FAILURE column, not on when a row was last hashed', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await sweepCosmeticPerceptualHashes();

    const sql = (mocks.queryRaw.mock.calls[0][0] as unknown as string[]).join('?');
    const beforeInterval = sql.slice(0, sql.indexOf('INTERVAL'));
    const window = beforeInterval.slice(beforeInterval.lastIndexOf('AND ('));
    expect(window).toContain('"pHashFailedAt"');
    expect(window).not.toContain('"pHashVersion"');
    expect(window).not.toContain('"pHashHex"');
  });

  it('does no work and reports none when the corpus is complete', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 0, hashed: 0, failed: 0 });
    expect(mocks.getPerceptualHash).not.toHaveBeenCalled();
  });
});
