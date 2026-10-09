import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as MilestoneShare from '~/server/services/creator-milestone-share.service';

const { getMilestoneShareCard } = vi.hoisted(() => ({ getMilestoneShareCard: vi.fn() }));
vi.mock('~/server/services/creator-milestone-share.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MilestoneShare>()),
  getMilestoneShareCard,
}));

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

const render = async (id: string) => {
  const res = makeRes();
  await handler(
    { method: 'GET', query: { type: 'milestone', id }, headers: {} } as unknown as NextApiRequest,
    res
  );
  return res;
};

const CARD = {
  username: 'ellie',
  avatarUrl: null,
  tierName: 'Supernova',
  accent: '#ae3ec9',
  badgeUrl: null,
  reached: 'November 2026',
};

beforeEach(() => {
  getMilestoneShareCard.mockReset().mockResolvedValue(CARD);
});

describe('/api/og?type=milestone', () => {
  it('reads `<userId>.<tierSlug>` and renders the card, not the fallback', async () => {
    const card = await render('42.supernova');
    getMilestoneShareCard.mockResolvedValue(null);
    const fallback = await render('42.supernova');

    expect(getMilestoneShareCard).toHaveBeenCalledWith({ userId: 42, slug: 'supernova' });
    expect(card._status).toBe(200);
    expect(card._headers['content-type']).toBe('image/png');
    expect(fallback._headers['content-type']).toBe('image/png');
    expect(Buffer.compare(card._body as Buffer, fallback._body as Buffer)).not.toBe(0);
  });

  // A backfilled tier's card carries no month. Rendered byte-for-byte against the literal text, so
  // a template that printed the null would match it.
  it('prints no "Reached" line when the card has no month', async () => {
    getMilestoneShareCard.mockResolvedValue({ ...CARD, reached: null });
    const noMonth = await render('42.supernova');
    getMilestoneShareCard.mockResolvedValue({ ...CARD, reached: 'null' });
    const printedNull = await render('42.supernova');

    expect(noMonth._headers['content-type']).toBe('image/png');
    expect(Buffer.compare(noMonth._body as Buffer, printedNull._body as Buffer)).not.toBe(0);
  });

  it('takes the SHORT cache for a card and for its fallback', async () => {
    // A hidden badge or a new strike must take a shared card down within minutes, and a card
    // that is not live yet must not sit on the hour-long fallback cache. Whole value, since
    // `toContain('max-age=300')` would also match `s-maxage=300`.
    const card = await render('42.supernova');
    getMilestoneShareCard.mockResolvedValue(null);
    const fallback = await render('42.supernova');

    expect(card._headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
    expect(fallback._headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
  });

  it('keeps the SHORT cache when the lookup throws', async () => {
    // The lookup is built to throw (an unreadable suppression list); the error path's hour-long
    // cache would pin a live creator's card to the fallback.
    getMilestoneShareCard.mockRejectedValue(new Error('suppression list unavailable'));
    const res = await render('42.supernova');

    expect(res._headers['content-type']).toBe('image/png');
    expect(res._headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
  });

  it('serves the fallback for an id that is not a score tier, without a lookup', async () => {
    for (const id of ['42.score:legend', '42.unknown', '42']) {
      const res = await render(id);
      expect(res._headers['content-type'], id).toBe('image/png');
    }
    expect(getMilestoneShareCard).not.toHaveBeenCalled();
  });
});
