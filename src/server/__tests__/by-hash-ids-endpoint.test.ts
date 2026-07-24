import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Focused test for src/pages/api/v1/model-versions/by-hash/ids.ts.
// Kept in src/server/__tests__ (NOT under src/pages) per CLAUDE.md: Next.js treats
// every file under src/pages as a route and `next build` fails on test files there.

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelFile: { findMany: mockFindMany } },
}));

// Unwrap PublicEndpoint so we can invoke the raw handler directly (no CORS/cache side effects).
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: Function) => handler,
}));

import handler from '~/pages/api/v1/model-versions/by-hash/ids';

const HASH = 'A'.repeat(64);
const HASH_2 = 'B'.repeat(64);

const runRequest = (body: unknown) => {
  const req = { method: 'POST', body } as unknown as NextApiRequest;
  const json = vi.fn().mockReturnThis();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as NextApiResponse;
  return { promise: handler(req, res), res, json };
};

describe('by-hash/ids endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes modelId alongside modelVersionId and hash for each result', async () => {
    mockFindMany.mockResolvedValue([
      { modelVersionId: 101, modelVersion: { modelId: 11 }, hashes: [{ hash: HASH }] },
      { modelVersionId: 202, modelVersion: { modelId: 22 }, hashes: [{ hash: HASH_2 }] },
    ]);

    const { promise, res, json } = runRequest([HASH, HASH_2]);
    await promise;

    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith([
      { modelVersionId: 101, modelId: 11, hash: HASH },
      { modelVersionId: 202, modelId: 22, hash: HASH_2 },
    ]);
  });

  it('selects modelVersion.modelId in the query', async () => {
    mockFindMany.mockResolvedValue([]);

    const { promise } = runRequest([HASH]);
    await promise;

    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.select.modelVersion.select.modelId).toBe(true);
    // Backward-compatible: existing fields still selected.
    expect(arg.select.modelVersionId).toBe(true);
    expect(arg.select.hashes.where.type).toBe('SHA256');
  });

  it('rejects a payload with an invalid (non-64-char) hash', async () => {
    const { promise, res, json } = runRequest(['tooshort']);
    await promise;

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('SHA256') })
    );
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
