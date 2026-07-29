import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAddLinked } = vi.hoisted(() => ({ mockAddLinked: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: mockAddLinked }));

import { processDedupePairs } from '~/server/jobs/dedupe-official-uploads';
import { constants } from '~/server/common/constants';

const OFFICIAL = constants.system.officialUserId;

beforeEach(() => vi.clearAllMocks());

describe('processDedupePairs', () => {
  const pair = {
    hostFileId: 500, hostType: 'VAE', hostVersionId: 10,
    canonicalFileId: 900, canonicalVersionId: 42, canonicalModelId: 7,
    canonicalModelName: 'Boogu VAE', canonicalVersionName: 'v1',
  };

  it('links each host onto the official canonical and reclaims its bytes', async () => {
    await processDedupePairs([pair], 10);
    expect(mockAddLinked).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 10, targetVersionId: 42, targetFileId: 900, replaceFileId: 500,
        componentType: 'VAE', userId: OFFICIAL, isModerator: true,
      })
    );
  });

  it('skips a host whose type has no component mapping', async () => {
    await processDedupePairs([{ ...pair, hostType: 'Archive' }], 10);
    expect(mockAddLinked).not.toHaveBeenCalled();
  });
});
