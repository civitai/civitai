import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite } = vi.hoisted(() => ({
  mockDbWrite: { $executeRaw: vi.fn(async () => 0) },
}));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: mockDbWrite }));

import { removeImageScanJobQueue } from '~/server/services/job-queue.service';

beforeEach(() => {
  mockDbWrite.$executeRaw.mockClear();
});

describe('removeImageScanJobQueue', () => {
  it('issues a delete when given image ids', async () => {
    await removeImageScanJobQueue([1, 2, 3]);
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    // Tagged-template call: the interpolated ids array is the last binding.
    const args = mockDbWrite.$executeRaw.mock.calls[0];
    expect(args[args.length - 1]).toEqual([1, 2, 3]);
  });

  it('no-ops on an empty id list (no DB round-trip)', async () => {
    await removeImageScanJobQueue([]);
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
