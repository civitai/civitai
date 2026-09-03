import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

const { getUserCollectionsWithPermissions } = await import('~/server/services/collection.service');

// The picker's owned/contributor/public branches are assembled as a single UNIONed Prisma.Sql.
// Find whichever argument carries the reconstructed text.
function capturedSql(): string {
  const call = mockDbRead.$queryRaw.mock.calls.at(-1) ?? [];
  for (const arg of call) {
    const sql = (arg as { sql?: unknown } | null)?.sql;
    if (typeof sql === 'string') return sql;
  }
  return '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockDbRead.tagsOnCollection.findMany.mockResolvedValue([]);
});

describe('getUserCollectionsWithPermissions archive filtering', () => {
  it('excludes archived collections when excludeArchived is set (the Save-to-collection picker)', async () => {
    await getUserCollectionsWithPermissions({ input: { userId: 1, excludeArchived: true } });
    expect(capturedSql()).toContain('"archivedAt" IS NULL');
  });

  it('leaves archived collections in for management surfaces when the flag is off', async () => {
    await getUserCollectionsWithPermissions({ input: { userId: 1 } });
    // The column is always projected; only the IS NULL filter is conditional.
    expect(capturedSql()).not.toContain('"archivedAt" IS NULL');
  });
});
