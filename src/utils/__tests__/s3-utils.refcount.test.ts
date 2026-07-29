import { describe, it, expect, vi, beforeEach } from 'vitest';

// urlsSafeToDelete only touches dbWrite.modelFile.findMany — no S3 client is
// exercised here, so the DB mock is the only thing we need to control
// (env vars and logToAxiom are already mocked globally in src/__tests__/setup.ts).
//
// The mock emulates real Prisma `where` filtering (url `in` + optional `id: { not }`)
// against a fixed dataset, rather than returning a canned array regardless of args —
// otherwise the test couldn't tell whether the code under test actually threads
// `excludeId` into the query.
type Row = { id: number; url: string };

const mocks = vi.hoisted(() => ({
  dataset: [] as Row[],
  findManyMock: vi.fn(),
}));

mocks.findManyMock.mockImplementation(
  async (args: { where: { url: { in: string[] }; id?: { not: number } } }) => {
    const { url, id } = args.where;
    return mocks.dataset.filter((row) => {
      if (!url.in.includes(row.url)) return false;
      if (id?.not != null && row.id === id.not) return false;
      return true;
    });
  }
);

vi.mock('~/server/db/client', () => ({
  dbWrite: { modelFile: { findMany: mocks.findManyMock } },
  dbRead: {},
}));

import { urlsSafeToDelete } from '~/utils/s3-utils';

beforeEach(() => {
  mocks.findManyMock.mockClear();
  mocks.dataset = [];
});

describe('urlsSafeToDelete — excludeId (self-row refcount guard)', () => {
  it('excludes the self-row: a job that keeps its own row can still free the S3 object', async () => {
    mocks.dataset = [{ id: 42, url: 'u' }];
    const result = await urlsSafeToDelete(['u'], 42);
    expect(result).toEqual({ safe: ['u'], skipped: 0 });
  });

  it('without excludeId, the same self-row still blocks deletion (guard preserved for existing callers)', async () => {
    mocks.dataset = [{ id: 42, url: 'u' }];
    const result = await urlsSafeToDelete(['u']);
    expect(result.safe).toEqual([]);
  });

  it('a genuinely different referencing row is still protected even when excludeId is set', async () => {
    mocks.dataset = [{ id: 99, url: 'u' }];
    const result = await urlsSafeToDelete(['u'], 42);
    expect(result.safe).toEqual([]);
  });
});
