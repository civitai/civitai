import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getHoldImagesById } = vi.hoisted(() => ({ getHoldImagesById: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/csam-holds.service', () => ({ getHoldImagesById }));

const { GET } = await import('../images/[holdId]/+server');
const { fetchHoldImages } = await import('$lib/csam-holds/hold-images');
const { holdHasImages } = await import('../hold-entity');

type Event = Parameters<typeof GET>[0];
const get = (holdId: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  GET({ params: { holdId }, locals: { grants } } as unknown as Event);

beforeEach(() => {
  vi.clearAllMocks();
  getHoldImagesById.mockResolvedValue(null);
});

describe('hold images endpoint', () => {
  it('serves the images of the hold', async () => {
    const found = { images: [{ id: 1, url: 'k', nsfwLevel: 1 }], total: 1, atLeast: false };
    getHoldImagesById.mockResolvedValue(found);
    const res = await get('12');
    expect(getHoldImagesById).toHaveBeenCalledWith(12);
    expect(await res.json()).toEqual({ images: found });
  });

  it('refuses a moderator without the csam permission before reading anything', async () => {
    await expect(get('12', {})).rejects.toMatchObject({ status: 403 });
    expect(getHoldImagesById).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-1', '99999999999'])('rejects the id %s', async (id) => {
    await expect(get(id)).rejects.toMatchObject({ status: 400 });
    expect(getHoldImagesById).not.toHaveBeenCalled();
  });
});

describe('fetchHoldImages', () => {
  const reply = (body: unknown, ok = true) =>
    vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;

  it('returns the images the endpoint sent', async () => {
    const found = { images: [], total: 0, atLeast: false };
    expect(await fetchHoldImages(4, reply({ images: found }))).toEqual(found);
  });

  it('returns null on a refusal, a bad body or a network failure instead of throwing', async () => {
    expect(await fetchHoldImages(4, reply({}, false))).toBeNull();
    expect(await fetchHoldImages(4, vi.fn().mockRejectedValue(new Error('offline')))).toBeNull();
    const broken = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => Promise.reject(new Error('x')) });
    expect(await fetchHoldImages(4, broken as unknown as typeof fetch)).toBeNull();
  });
});

describe('holdHasImages', () => {
  it('is true for posts and models only', () => {
    expect(['Post', 'Model'].every(holdHasImages)).toBe(true);
    expect(['ChatMessage', 'Comment', 'CommentV2', 'UserProfile'].some(holdHasImages)).toBe(false);
  });
});
