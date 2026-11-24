import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/song-card/[imageId]`: a song card's text and cover, for a moderator. What the card shows is
 * pinned against real SQL in `song-card.pglite.test.ts`; this file mocks the reads.
 */

const getSongCard = vi.hoisted(() => vi.fn());
const withheldImageIds = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/song-card.service', () => ({ getSongCard }));
vi.mock('$lib/server/retracted-media', () => ({ withheldImageIds }));

const { GET } = await import('../../../routes/api/song-card/[imageId]/+server');

const CARD = { id: 7, url: 'k', title: 'Song', durationSec: 60, cover: null, lines: [] };

const call = async ({ user = { id: 42 } as { id: number } | null, imageId = '7' } = {}) => {
  const res = await GET({ params: { imageId }, locals: { user } } as never);
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
};

beforeEach(() => {
  vi.clearAllMocks();
  getSongCard.mockResolvedValue(CARD);
  withheldImageIds.mockResolvedValue([]);
});

describe('/api/song-card', () => {
  it('answers a moderator with the card, no-store', async () => {
    expect(await call()).toEqual({ status: 200, body: CARD, cache: 'private, no-store' });
    expect(getSongCard).toHaveBeenCalledWith(7);
  });

  it('refuses a request with no moderator behind it, before reading anything', async () => {
    expect((await call({ user: null })).status).toBe(403);
    expect(getSongCard).not.toHaveBeenCalled();
    expect(withheldImageIds).not.toHaveBeenCalled();
  });

  it('refuses a song withheld from this moderator without reading its lyrics', async () => {
    withheldImageIds.mockResolvedValue([7]);
    expect((await call()).status).toBe(404);
    expect(getSongCard).not.toHaveBeenCalled();
  });

  it('answers 404 for an image that is not a song, and 400 for a bad id', async () => {
    getSongCard.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect((await call({ imageId: 'x' })).status).toBe(400);
  });
});
