import { describe, it, expect, vi, beforeEach } from 'vitest';

// 🔴 NOT ABOUT THIS FILE'S ASSERTIONS — it is about its EXIT CODE. The code
// under test is pure, but it is reached through a module that imports
// `~/server/db/client` at module scope, which instantiates Prisma and leaves an
// UNHANDLED rejection. That rejection fails no test; it only makes the runner
// exit non-zero, so `rc` here did not describe the tests and any mutation sweep
// reading it reported every mutant killed. Nothing below touches a database.
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
