import { describe, it, expect, vi, beforeEach } from 'vitest';

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
