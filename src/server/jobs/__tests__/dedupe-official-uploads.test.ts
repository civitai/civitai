import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked for the EXIT CODE, not the assertions. Reached transitively, this
// module instantiates Prisma — and in a worktree without the repo's flake
// dev-shell that leaves an unhandled rejection which fails no test but still
// sets rc=1, so a mutation sweep reading rc scores every mutant as killed.
// Nothing below touches a database. See civitai#3576.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

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
