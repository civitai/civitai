import type * as BlockedImageHash from '~/server/services/blocked-image-hash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getIsImageBlocked } = vi.hoisted(() => ({ getIsImageBlocked: vi.fn(async () => true) }));
vi.mock('~/server/services/blocked-image-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockedImageHash>()),
  getIsImageBlocked,
  canCheckBlockedImageHash: () => true,
}));

const { logToAxiom } = await import('~/server/logging/client');
const { logPerceptualHashMatch } = await import('~/server/services/image-scan-pipeline');

// Past 2^53, so any rendering of it (string, number, hex digits aside) is recognisable.
const PHASH = BigInt('-4276845791567733103');

beforeEach(() => {
  vi.mocked(logToAxiom).mockClear();
  getIsImageBlocked.mockResolvedValue(true);
});

describe('logPerceptualHashMatch', () => {
  it('logs a match by image, without the perceptual hash', async () => {
    await logPerceptualHashMatch({ imageId: 7, pHash: PHASH });

    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-phash-match', type: 'info', imageId: 7 }),
      'webhooks'
    );
    const logged = JSON.stringify(vi.mocked(logToAxiom).mock.calls, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v
    );
    expect(logged).not.toContain(PHASH.toString().slice(1));
  });

  it('logs nothing for an image that matches nothing (control)', async () => {
    getIsImageBlocked.mockResolvedValue(false);

    await logPerceptualHashMatch({ imageId: 7, pHash: PHASH });

    expect(vi.mocked(logToAxiom)).not.toHaveBeenCalled();
  });
});
