import { describe, expect, it, vi } from 'vitest';
import { imageAuditContentHash } from '@civitai/shared/media-signals';

const query = vi.hoisted(() => vi.fn());
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query }) }));
vi.mock('../db', () => ({ dbWrite: {} }));
vi.mock('../redis', () => ({ getRedis: () => ({}), getSysRedis: () => ({}) }));

const { readScannerCsamVerdicts } = await import('../review-batch');

describe('readScannerCsamVerdicts', () => {
  it("reads each image's CSAM verdict in one query", async () => {
    query.mockResolvedValueOnce({
      json: async () => [
        { contentHash: imageAuditContentHash(1), hit: 1, csamHit: 1 },
        { contentHash: imageAuditContentHash(2), hit: 0, csamHit: 0 },
      ],
    });
    expect(await readScannerCsamVerdicts([1, 2, 3])).toEqual(
      new Map([
        [1, 'hit'],
        [2, 'clear'],
        [3, 'none'],
      ])
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].query_params.hashes).toEqual(
      [1, 2, 3].map(imageAuditContentHash)
    );
  });

  it('answers null when the scanner cannot be read, and sends no query for no images', async () => {
    query.mockClear();
    query.mockRejectedValueOnce(new Error('timeout'));
    expect(await readScannerCsamVerdicts([1])).toBeNull();
    expect(await readScannerCsamVerdicts([])).toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(1);
  });
});
