import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindBySize } = vi.hoisted(() => ({
  mockFindBySize: vi.fn(),
}));
vi.mock('~/server/services/official-file.service', () => ({
  findOfficialFilesBySize: mockFindBySize,
}));

import { findOfficialFilesBySizeHandler } from '~/server/controllers/model-file.controller';

beforeEach(() => vi.clearAllMocks());

describe('findOfficialFilesBySize handler', () => {
  it('converts bytes to KB before querying', async () => {
    mockFindBySize.mockResolvedValue([{ id: 1 }]);
    const res = await findOfficialFilesBySizeHandler({ size: 300_000 * 1024 });
    expect(mockFindBySize).toHaveBeenCalledWith(300_000);
    expect(res).toEqual([{ id: 1 }]);
  });
});
