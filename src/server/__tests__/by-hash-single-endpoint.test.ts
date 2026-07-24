import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Focused test for src/pages/api/v1/model-versions/by-hash/[hash].ts.
// Kept in src/server/__tests__ (NOT under src/pages) per CLAUDE.md.

const { mockFindFirst, mockResDetails } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockResDetails: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelFile: { findFirst: mockFindFirst } },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: Function) => handler,
}));

// Avoid pulling the heavy model-version response graph.
vi.mock('~/pages/api/v1/model-versions/[id]', () => ({
  resModelVersionDetails: mockResDetails,
}));

vi.mock('~/server/selectors/modelVersion.selector', () => ({
  getModelVersionApiSelect: {},
}));

import handler from '~/pages/api/v1/model-versions/by-hash/[hash]';

const HASH = 'a'.repeat(64);

const runRequest = (query: Record<string, string>) => {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  return { promise: handler(req, res), res };
};

describe('by-hash/[hash] endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries with a deterministic orderBy (oldest published version, id tiebreak)', async () => {
    mockFindFirst.mockResolvedValue({ modelVersion: { id: 1 } });

    const { promise } = runRequest({ hash: HASH });
    await promise;

    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    const arg = mockFindFirst.mock.calls[0][0];
    expect(arg.orderBy).toEqual([
      { modelVersion: { publishedAt: 'asc' } },
      { modelVersion: { id: 'asc' } },
    ]);
    // Matching semantics unchanged: still Published-only, any-hash-type.
    expect(arg.where.modelVersion).toEqual({
      model: { status: 'Published' },
      status: 'Published',
    });
  });

  it('passes null modelVersion through when no file matches', async () => {
    mockFindFirst.mockResolvedValue(null);

    const { promise } = runRequest({ hash: HASH });
    await promise;

    expect(mockResDetails).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
  });
});
