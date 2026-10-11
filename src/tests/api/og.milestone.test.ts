import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
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
  name: 'Supernova',
  eyebrow: 'Creator Score Tier',
  accent: '#ae3ec9',
  reachedVerb: 'Reached',
  line: null,
  badgeUrl: null,
  decoration: null,
  profileBadgeUrl: null,
  reached: 'November 2026',
};

beforeEach(() => {
  getMilestoneShareCard.mockReset().mockResolvedValue(CARD);
  vi.unstubAllGlobals();
});

describe('/api/og?type=milestone', () => {
  it('reads `<userId>.<tierSlug>` and renders the card, not the fallback', async () => {
    const card = await render('42.supernova');
    getMilestoneShareCard.mockResolvedValue(null);
    const fallback = await render('42.supernova');

    expect(getMilestoneShareCard).toHaveBeenCalledWith({ userId: 42, milestone: 'supernova' });
    expect(card._status).toBe(200);
    expect(card._headers['content-type']).toBe('image/png');
    expect(fallback._headers['content-type']).toBe('image/png');
    expect(Buffer.compare(card._body as Buffer, fallback._body as Buffer)).not.toBe(0);
  });

  // A backfilled tier's card carries no month, so it must print no "Reached" line at all. Compared
  // byte-for-byte against a line holding each thing a broken template would print in its place.
  describe('the "Reached" line', () => {
    const png = async (reached: string | null) => {
      getMilestoneShareCard.mockResolvedValue({ ...CARD, reached });
      return (await render('42.supernova'))._body as Buffer;
    };

    it('renders the same card to the same bytes, so a difference below means something', async () => {
      expect(Buffer.compare(await png(null), await png(null))).toBe(0);
    });

    it('is absent when the card has no month', async () => {
      const noMonth = await png(null);
      for (const filler of [' ', 'null', 'undefined'])
        expect(Buffer.compare(noMonth, await png(filler)), filler).not.toBe(0);
    });

    it('is present when the card has a month', async () => {
      expect(Buffer.compare(await png('November 2026'), await png(null))).not.toBe(0);
    });
  });

  it('reads `<userId>.<achievementKey>` and looks up that achievement', async () => {
    const res = await render('42.reach:downloads-10000');
    expect(getMilestoneShareCard).toHaveBeenCalledTimes(1);
    expect(getMilestoneShareCard).toHaveBeenCalledWith({
      userId: 42,
      milestone: 'reach:downloads-10000',
    });
    expect(res._headers['content-type']).toBe('image/png');
  });

  // An achievement's card carries its own small capitals and a line saying what the creator did.
  it("draws an achievement's eyebrow and line", async () => {
    const png = async (card: Record<string, unknown>) => {
      getMilestoneShareCard.mockResolvedValue({ ...CARD, ...card });
      return (await render('42.supernova'))._body as Buffer;
    };
    const achievement = { name: '10k Downloads', eyebrow: 'Reach Achievement' };

    const bare = await png(achievement);
    expect(Buffer.compare(await png(achievement), bare)).toBe(0);
    const lined = await png({ ...achievement, line: 'One model reached 10,000 downloads' });
    const tier = await png({ ...achievement, eyebrow: 'Creator Score Tier' });

    const earned = await png({ ...achievement, reachedVerb: 'Earned' });

    expect(Buffer.compare(lined, bare)).not.toBe(0);
    expect(Buffer.compare(tier, bare)).not.toBe(0);
    // CARD says "Reached"; an achievement says "Earned" before its month.
    expect(Buffer.compare(earned, bare)).not.toBe(0);
  });

  // Each piece of art is fetched and drawn: a card that dropped one would render the same bytes as
  // a card that never had it.
  it("draws the creator's avatar frame and profile badge", async () => {
    const art = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .webp()
      .toBuffer();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array(art), { headers: { 'content-type': 'image/webp' } })
      )
    );
    const png = async (card: Record<string, unknown>) => {
      getMilestoneShareCard.mockResolvedValue({ ...CARD, ...card });
      return (await render('42.supernova'))._body as Buffer;
    };

    const bare = await png({});
    // The same card renders to the same bytes, so the differences below are the art.
    expect(Buffer.compare(await png({}), bare)).toBe(0);
    const framed = await png({ decoration: { url: 'https://edge/frame', offset: '30%' } });
    const badged = await png({ profileBadgeUrl: 'https://edge/badge' });

    expect(Buffer.compare(framed, bare)).not.toBe(0);
    expect(Buffer.compare(badged, bare)).not.toBe(0);
    expect(Buffer.compare(framed, badged)).not.toBe(0);
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

  it('serves the fallback for an id naming no tier or achievement, without a lookup', async () => {
    for (const id of ['42.score:legend', '42.unknown', '42', '42.other:x', '42.reach:A']) {
      const res = await render(id);
      expect(res._headers['content-type'], id).toBe('image/png');
    }
    expect(getMilestoneShareCard).not.toHaveBeenCalled();
  });
});
