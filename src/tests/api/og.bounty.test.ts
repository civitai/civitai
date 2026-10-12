import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import handler from '~/pages/api/og';

type CapturedRes = NextApiResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
};

function makeRes(): CapturedRes {
  const res = { _status: 200, _headers: {}, _body: undefined } as unknown as CapturedRes;
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.setHeader = vi.fn((k: string, v: string) => {
    res._headers[k.toLowerCase()] = v;
    return res;
  }) as any;
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.end = vi.fn(() => res) as any;
  return res;
}

const render = async (query: Record<string, string>) => {
  const res = makeRes();
  await handler({ method: 'GET', query, headers: {} } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.bounty.findFirst.mockResolvedValue({
    name: 'B',
    description: '',
    user: { username: 'u' },
  });
  dbMock.dbRead.bountyMetric.findFirst.mockResolvedValue(null);
  dbMock.dbRead.imageConnection.findFirst.mockResolvedValue(null);
});

describe('/api/og?type=bounty', () => {
  it('never reads a Private bounty for the card', async () => {
    await render({ type: 'bounty', id: '9' });
    expect(dbMock.dbRead.bounty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9, availability: { not: 'Private' } } })
    );
  });

  // A bounty can be hidden after its card was cached; the 7-day edge cache would keep serving it.
  it('takes the short cache', async () => {
    const res = await render({ type: 'bounty', id: '9' });
    expect(res._headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
  });
});
