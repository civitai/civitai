import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/held-media/[imageId]` and `/api/retracted-media/[imageId]` decide by the CSAM page's grant
 * alone: no environment setting opens held media, or the restricted tier of blocked media, to a
 * moderator without it. The env below sets a switch these routes once read, to show it is ignored.
 */

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';
const MEDIA = { url: KEY, type: 'image', mimeType: null };

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  getHeldMedia: vi.fn(),
  getRetractedMedia: vi.fn(),
  insertModActivity: vi.fn(async (_row: Record<string, unknown>) => {}),
  recordRetractedView: vi.fn(async () => {}),
}));

vi.mock('$env/dynamic/private', () => ({ env: { CSAM_VIEW_COVERED_ENABLED: 'true' } }));
vi.mock('$lib/server/access', async () => {
  const { error } = await import('@sveltejs/kit');
  const canAccess = (_user: unknown, path: string) => h.grants.has(path);
  return {
    canAccess,
    requireAccess: (user: unknown, path: string) => {
      if (!canAccess(user, path)) error(403, 'no');
    },
  };
});
vi.mock('$lib/server/held-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../held-media')>()),
  getHeldMedia: h.getHeldMedia,
}));
vi.mock('$lib/server/retracted-media', () => ({
  getRetractedMedia: h.getRetractedMedia,
  recordRetractedView: h.recordRetractedView,
  retractedMediaEnabled: () => true,
}));
// Any read that reaches the database fails, so a route that reads anything but the mocks refuses.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/mod-activity', () => ({
  insertModActivity: h.insertModActivity,
  recordModActivity: vi.fn(),
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));
vi.mock('$lib/server/storage', () => ({
  getStorage: () => ({
    getGetUrl: async (input: { key?: string }) => ({
      url: `https://store.test/signed/${input.key}`,
    }),
  }),
}));

const { GET: held } = await import('../../../routes/api/held-media/[imageId]/+server');
const { GET: retracted } = await import('../../../routes/api/retracted-media/[imageId]/+server');
const { HELD_MEDIA_PAGE } = await import('../held-media');

async function call(route: (event: never) => unknown, path: string) {
  const url = new URL(`http://mod.test${path}`);
  try {
    const res = (await route({
      params: { imageId: '7' },
      url,
      request: new Request(url),
      cookies: { get: () => undefined },
      locals: { user: { id: 42, roles: ['moderator:staff'] }, grants: {} },
    } as never)) as Response;
    return res.status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.grants = new Set();
  h.getHeldMedia.mockResolvedValue(MEDIA);
  h.getRetractedMedia.mockResolvedValue({ ...MEDIA, tier: 'plain' });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('bytes', {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
        })
    )
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('held media without the CSAM page', () => {
  it('is refused, and no image is read', async () => {
    expect(await call(held, '/api/held-media/7')).toBe(403);
    expect(h.getHeldMedia).not.toHaveBeenCalled();
  });

  it('is served, and logged, with the CSAM page', async () => {
    h.grants.add(HELD_MEDIA_PAGE);
    expect(await call(held, '/api/held-media/7')).toBe(200);
    expect(h.getHeldMedia).toHaveBeenCalledWith(7);
    expect(h.insertModActivity).toHaveBeenCalled();
  });
});

describe('blocked media without the CSAM page', () => {
  it('goes through the eligibility read without the CSAM tier', async () => {
    expect(await call(retracted, '/api/retracted-media/7')).toBe(200);
    expect(h.getRetractedMedia).toHaveBeenCalledWith(7, { csamReview: false });
    expect(h.recordRetractedView).toHaveBeenCalledWith(42, 7);
  });

  it('is refused when that read refuses', async () => {
    h.getRetractedMedia.mockResolvedValue(null);
    expect(await call(retracted, '/api/retracted-media/7')).toBe(404);
  });

  it('asks for the CSAM tier with the CSAM page', async () => {
    h.grants.add(HELD_MEDIA_PAGE);
    expect(await call(retracted, '/api/retracted-media/7')).toBe(200);
    expect(h.getRetractedMedia).toHaveBeenCalledWith(7, { csamReview: true });
  });
});
