import { describe, expect, it, vi } from 'vitest';
import { feedFliptContext, serveFromFeed } from '../feed-primary.service';
import type { FeedAnswer } from '../feed-shadow.service';

const base = { sort: 'Most Reactions', period: 'Week', browsingLevel: 31, limit: 100 };
const answer = (ids: number[], extra: Partial<FeedAnswer> = {}): FeedAnswer => ({
  status: 200,
  ms: 7,
  ids,
  ...extra,
});
const rows = (ids: number[]) => ids.map((id) => ({ id, url: `u${id}` }));

describe('serveFromFeed', () => {
  it('keeps the feed order, drops what hydration filtered out and hands back a feed cursor', async () => {
    const hydrate = vi.fn(async (ids: number[]) => rows(ids.filter((id) => id !== 5).reverse()));
    const fetchFeed = vi.fn(async () =>
      answer([9, 5, 2], { nextCursor: '17808|2', route: 'tag-walk' })
    );
    const r = await serveFromFeed(base, { fetchFeed, hydrate });
    expect(r.ok && r.page.data.map((d) => d.id)).toEqual([9, 2]);
    expect(r.ok && r.page.nextCursor).toBe('feed:17808:2');
    expect(r.ok && r.page.route).toBe('tag-walk');
    expect(hydrate).toHaveBeenCalledWith([9, 5, 2]);
    expect(new URLSearchParams(fetchFeed.mock.calls[0]?.[0] as string).get('sort')).toBe(
      'reactions'
    );
  });

  it('serves an empty page as end of feed without hydrating', async () => {
    const hydrate = vi.fn(async () => []);
    const r = await serveFromFeed(base, { fetchFeed: async () => answer([]), hydrate });
    expect(r).toEqual({
      ok: true,
      page: { data: [], nextCursor: undefined, feedMs: 7, route: undefined },
    });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('falls back with a reason when the shape, the call or the status is not servable', async () => {
    const hydrate = async () => [];
    expect(
      await serveFromFeed(
        { ...base, followed: true },
        { fetchFeed: async () => answer([1]), hydrate }
      )
    ).toEqual({
      ok: false,
      reason: 'flag:followed',
    });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(
      await serveFromFeed(base, { fetchFeed: async () => Promise.reject(timeout), hydrate })
    ).toEqual({
      ok: false,
      reason: 'timeout',
    });
    expect(
      await serveFromFeed(base, { fetchFeed: async () => answer([], { status: 503 }), hydrate })
    ).toEqual({
      ok: false,
      reason: 'status:503',
    });
  });
});

describe('feedFliptContext', () => {
  it('matches the shape of the request-path context for the fields the search input carries', () => {
    expect(feedFliptContext({})).toEqual({ isLoggedIn: 'false' });
    expect(feedFliptContext({ currentUserId: 6, isModerator: true })).toEqual({
      userId: '6',
      isModerator: 'true',
      isLoggedIn: 'true',
    });
  });
});
