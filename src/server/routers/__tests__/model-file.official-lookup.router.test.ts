import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindBySize, mockFindByHash } = vi.hoisted(() => ({
  mockFindBySize: vi.fn(),
  mockFindByHash: vi.fn(),
}));
vi.mock('~/server/services/official-file.service', () => ({
  findOfficialFilesBySize: mockFindBySize,
  findOfficialFileByHash: mockFindByHash,
}));

import { findOfficialFilesBySizeHandler } from '~/server/routers/model-file.router';

beforeEach(() => vi.clearAllMocks());

describe('findOfficialFilesBySize handler', () => {
  it('converts bytes to KB before querying', async () => {
    mockFindBySize.mockResolvedValue([{ id: 1 }]);
    const res = await findOfficialFilesBySizeHandler({ size: 300_000 * 1024 });
    expect(mockFindBySize).toHaveBeenCalledWith(300_000);
    expect(res).toEqual([{ id: 1 }]);
  });
});
