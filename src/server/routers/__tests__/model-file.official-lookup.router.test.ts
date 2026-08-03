import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked for the EXIT CODE, not the assertions. Reached transitively, this
// module instantiates Prisma — and in a worktree without the repo's flake
// dev-shell that leaves an unhandled rejection which fails no test but still
// sets rc=1, so a mutation sweep reading rc scores every mutant as killed.
// Nothing below touches a database. See civitai#3576.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

const { mockFindBySize } = vi.hoisted(() => ({
  mockFindBySize: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  hasOfficialFileOfSize: mockFindBySize,
}));

import { hasOfficialFileOfSizeHandler } from '~/server/controllers/model-file.controller';

beforeEach(() => vi.clearAllMocks());

describe('hasOfficialFileOfSize handler', () => {
  it('converts bytes to KB before querying', async () => {
    mockFindBySize.mockResolvedValue(true);
    const res = await hasOfficialFileOfSizeHandler({
      input: { size: 300_000 * 1024 },
      ctx: {} as never,
    });
    expect(mockFindBySize).toHaveBeenCalledWith(300_000);
    expect(res).toBe(true);
  });
});
