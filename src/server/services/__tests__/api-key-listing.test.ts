import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { getUserApiKeys } = await import('~/server/services/api-key.service');

type Row = { id: number; userId: number; type: string; name: string; expiresAt: Date | null };
const NOW = new Date('2026-10-27T12:00:00.000Z');
const rows: Row[] = [
  { id: 1, userId: 7, type: 'User', name: 'live', expiresAt: null },
  {
    id: 2,
    userId: 7,
    type: 'User',
    name: 'expiring later',
    expiresAt: new Date(NOW.getTime() + 60_000),
  },
  {
    id: 3,
    userId: 7,
    type: 'User',
    name: 'revoked by a ban',
    expiresAt: new Date(NOW.getTime() - 60_000),
  },
];

/** The listing's own `where`, applied to the rows: userId, type, and the expiry OR. */
function applies(row: Row, where: Record<string, unknown>) {
  const or = where.OR as { expiresAt: null | { gt: Date } }[] | undefined;
  const live = or
    ? or.some(({ expiresAt }) =>
        expiresAt === null
          ? row.expiresAt === null
          : !!row.expiresAt && row.expiresAt > expiresAt.gt
      )
    : true;
  return row.userId === where.userId && row.type === where.type && live;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dbMock.dbRead.apiKey.findMany.mockImplementation((async ({
    where,
  }: {
    where: Record<string, unknown>;
  }) => rows.filter((r) => applies(r, where))) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the owner’s API key list', () => {
  it('leaves out keys that have expired, such as those a ban revoked', async () => {
    const keys = await getUserApiKeys({ userId: 7 });
    expect(keys.map((k) => k.name)).toEqual(['live', 'expiring later']);
  });
});
