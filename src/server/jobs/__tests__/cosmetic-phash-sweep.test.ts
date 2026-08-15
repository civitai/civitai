import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticPhashService from '~/server/services/cosmetic-phash.service';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    queryRaw: vi.fn(),
    getPerceptualHash: vi.fn(),
    storeCosmeticPerceptualHash: vi.fn(),
    markCosmeticHashAttempted: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: { $queryRaw: mocks.queryRaw }, dbWrite: {} }));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  getPerceptualHash: mocks.getPerceptualHash,
}));
vi.mock('~/server/services/cosmetic-phash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPhashService>()),
  storeCosmeticPerceptualHash: mocks.storeCosmeticPerceptualHash,
  markCosmeticHashAttempted: mocks.markCosmeticHashAttempted,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

import { COSMETIC_PHASH_LANE } from '~/server/services/cosmetic-phash.service';
import { sweepCosmeticPerceptualHashes } from '../cosmetic-phash-sweep';

describe('sweepCosmeticPerceptualHashes', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.storeCosmeticPerceptualHash.mockResolvedValue(undefined);
    mocks.markCosmeticHashAttempted.mockResolvedValue(undefined);
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
    expect(mocks.markCosmeticHashAttempted).toHaveBeenCalledWith(240);
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
    expect(mocks.markCosmeticHashAttempted).toHaveBeenCalledWith(2);
  });

  it('selects on the version as well as the url, which is what drains a lane upgrade', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await sweepCosmeticPerceptualHashes();

    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    const sql = (strings as unknown as string[]).join('?');
    expect(sql).toContain('"pHashVersion" IS DISTINCT FROM');
    expect(sql).toContain('"pHashUrl" IS DISTINCT FROM');
    expect(sql).toContain('"pHashCheckedAt" ASC NULLS FIRST');
    expect(values).toContain(COSMETIC_PHASH_LANE.version);
  });

  it('does no work and reports none when the corpus is complete', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    expect(await sweepCosmeticPerceptualHashes()).toEqual({ scanned: 0, hashed: 0, failed: 0 });
    expect(mocks.getPerceptualHash).not.toHaveBeenCalled();
  });
});
