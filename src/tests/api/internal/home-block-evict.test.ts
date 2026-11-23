import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The moderator app reaches the home-block refresh through this endpoint
// (apps/moderator/src/lib/server/home-blocks.ts).

const TOKEN = 'home-block-evict-test-token-0123456789';
vi.mock('~/env/server', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (prop === 'WEBHOOK_TOKEN') return 'home-block-evict-test-token-0123456789';
      if (prop === 'LOGGING' || prop.endsWith('ORIGINS')) return [];
      if (prop === 'IS_BUILD') return false;
      if (prop.endsWith('URL') || prop.endsWith('ENDPOINT')) return 'http://localhost:3000';
      if (/(CONCURRENCY|LIMIT|TIMEOUT|DELAY)$/.test(prop)) return 4;
      return 'mock-value';
    },
  }),
}));

const handler = (await import('~/pages/api/internal/home-block-evict')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

async function call(body: unknown, token = TOKEN) {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  };
  await handler(
    {
      method: 'POST',
      body,
      query: { token },
      headers: { host: 'localhost:3000' },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { statusCode: res.status.mock.calls.at(-1)?.[0] as number | undefined };
}

// The refresh's collection lookup, seen at the database: the ids bound as one array.
const lookedUp = () =>
  dbMock.dbRead.$queryRaw.mock.calls
    .map(([query]) => query as unknown as { sql?: string; values?: unknown[] })
    .filter((query) => !!query?.sql?.includes('"CollectionItem"'))
    .flatMap((query) => (query.values ?? []).filter(Array.isArray));

describe('home-block-evict', () => {
  it('refreshes the home blocks showing the given images', async () => {
    dbMock.dbRead.$queryRaw.mockClear();
    const res = await call({ imageIds: [42, 42, 43] });

    expect(res.statusCode).toBe(200);
    expect(lookedUp()).toContainEqual([42, 43]);
  });

  it('refuses a call without the token, and looks nothing up', async () => {
    dbMock.dbRead.$queryRaw.mockClear();
    const res = await call({ imageIds: [42] }, 'wrong');

    expect(res.statusCode).toBe(401);
    expect(lookedUp()).toEqual([]);
  });

  it('refuses a body without image ids, and looks nothing up', async () => {
    dbMock.dbRead.$queryRaw.mockClear();
    const res = await call({ imageIds: [] });
    expect(res.statusCode).toBe(400);
    expect(lookedUp()).toEqual([]);
  });
});
