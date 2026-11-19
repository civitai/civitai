import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The covered view on `/api/held-media/[imageId]` and `/api/retracted-media/[imageId]`: a moderator
 * without the CSAM page's grant, with `CSAM_VIEW_COVERED_ENABLED` on. Which images it serves is pinned
 * against real SQL in `csam-view-covered.pglite.test.ts`; this file mocks that read and pins what
 * the routes do with its answer: reported bytes answer as a missing image, and every response with
 * bytes writes its view row first.
 */

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';
const MEDIA = { url: KEY, type: 'image', mimeType: null };

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  coveredOn: true,
  getCoveredHeldMedia: vi.fn(),
  getCoveredRetractedMedia: vi.fn(),
  getHeldMedia: vi.fn(),
  getRetractedMedia: vi.fn(),
  insertModActivity: vi.fn(async (_row: Record<string, unknown>) => {}),
  recordRetractedView: vi.fn(async () => {}),
}));

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
vi.mock('$lib/server/csam-view', () => ({
  COVERED_REFUSED: 'covered-refused',
  coveredViewEnabled: () => h.coveredOn,
  getCoveredHeldMedia: h.getCoveredHeldMedia,
  getCoveredRetractedMedia: h.getCoveredRetractedMedia,
}));
vi.mock('$lib/server/held-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../held-media')>()),
  getHeldMedia: h.getHeldMedia,
}));
vi.mock('$lib/server/retracted-media', () => ({
  getRetractedMedia: h.getRetractedMedia,
  recordRetractedView: h.recordRetractedView,
  NEEDS_CSAM_QUEUE: 'needs-csam-queue',
  retractedMediaEnabled: () => true,
}));
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

const fetchMock = vi.fn();

async function call(
  route: (event: never) => unknown,
  path: string,
  { headers = {} as Record<string, string>, sheet = false, method = 'GET', query = '' } = {}
) {
  const url = new URL(`http://mod.test${path}${query}`);
  try {
    const res = (await route({
      params: { imageId: '7' },
      url,
      request: new Request(url, { headers, method }),
      cookies: { get: () => undefined },
      locals: {
        user: { id: 42, roles: ['moderator:staff'] },
        grants: {},
        ...(sheet ? { heldCredential: 'sheet' } : {}),
      },
    } as never)) as Response;
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500 };
  }
}
const getHeld = (opts?: Parameters<typeof call>[2]) => call(held, '/api/held-media/7', opts);
const getRetracted = (opts?: Parameters<typeof call>[2]) =>
  call(retracted, '/api/retracted-media/7', opts);

beforeEach(() => {
  vi.clearAllMocks();
  h.grants = new Set();
  h.coveredOn = true;
  h.getCoveredHeldMedia.mockResolvedValue(MEDIA);
  h.getCoveredRetractedMedia.mockResolvedValue({ ...MEDIA, tier: 'suspect' });
  h.getHeldMedia.mockResolvedValue(MEDIA);
  h.getRetractedMedia.mockResolvedValue({ ...MEDIA, tier: 'plain' });
  h.insertModActivity.mockResolvedValue(undefined);
  h.recordRetractedView.mockResolvedValue(undefined);
  fetchMock.mockImplementation(
    async () =>
      new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const midFile = () =>
  fetchMock.mockResolvedValue(
    new Response('ytes', {
      status: 206,
      headers: {
        'content-type': 'image/jpeg',
        'content-range': 'bytes 1-4/5',
        'content-length': '4',
      },
    })
  );

describe('held media on the covered view', () => {
  it('serves a covered image and writes its heldMedia:view row from the web', async () => {
    const { status, res } = await getHeld();
    expect(status).toBe(200);
    expect(await res!.text()).toBe('bytes');
    expect(h.getCoveredHeldMedia).toHaveBeenCalledWith(7, 42);
    expect(h.insertModActivity).toHaveBeenCalledTimes(1);
    expect(h.insertModActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        entityId: 7,
        activity: 'heldMedia:view',
        credential: 'web',
      })
    );
  });

  it('writes a row for a range that starts mid-file', async () => {
    midFile();
    expect((await getHeld({ headers: { range: 'bytes=1-' } })).status).toBe(206);
    expect(h.insertModActivity).toHaveBeenCalledTimes(1);
  });

  it('sends no bytes when the row is not written', async () => {
    h.insertModActivity.mockRejectedValue(new Error('down'));
    const { status, res } = await getHeld();
    expect(status).toBe(503);
    expect(res).toBeUndefined();
  });

  it('answers reported bytes, or a failed read, as a missing image, touching no storage', async () => {
    h.getCoveredHeldMedia.mockResolvedValue('covered-refused');
    expect((await getHeld()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.insertModActivity).not.toHaveBeenCalled();
  });

  it('answers an image it does not cover with the same 404 as a reported one', async () => {
    h.getCoveredHeldMedia.mockResolvedValue(null);
    expect((await getHeld()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers reported bytes and an image it does not cover identically', async () => {
    const answer = async (read: unknown) => {
      h.getCoveredHeldMedia.mockResolvedValue(read);
      const e = await Promise.resolve(
        held({
          params: { imageId: '7' },
          url: new URL('http://mod.test/api/held-media/7'),
          request: new Request('http://mod.test/api/held-media/7'),
          cookies: { get: () => undefined },
          locals: { user: { id: 42 }, grants: {} },
        } as never)
      ).then(
        () => null,
        (err: unknown) => err
      );
      return JSON.stringify(e);
    };
    expect(await answer('covered-refused')).toBe(await answer(null));
  });

  it('writes the row before storage is touched, so a range past the end is recorded too', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 416 }));
    expect((await getHeld({ headers: { range: 'bytes=5-' } })).status).toBe(416);
    expect(h.insertModActivity).toHaveBeenCalledTimes(1);
  });

  it('answers HEAD without reading the image', async () => {
    expect((await getHeld({ method: 'HEAD' })).status).toBe(404);
    expect(h.getCoveredHeldMedia).not.toHaveBeenCalled();
  });

  it('is off unless switched on', async () => {
    h.coveredOn = false;
    expect((await getHeld()).status).toBe(403);
    expect(h.getCoveredHeldMedia).not.toHaveBeenCalled();
  });

  it('never covers the sheet credential', async () => {
    expect((await getHeld({ sheet: true })).status).toBe(403);
    expect(h.getCoveredHeldMedia).not.toHaveBeenCalled();
  });

  it('leaves a moderator with the CSAM page on the existing path', async () => {
    h.grants = new Set(['/images/csam']);
    expect((await getHeld()).status).toBe(200);
    expect(h.getCoveredHeldMedia).not.toHaveBeenCalled();
    expect(h.getHeldMedia).toHaveBeenCalledWith(7);
  });
});

describe('blocked media on the covered view', () => {
  it('serves a covered image without the tier or verdict checks, writing a row per range', async () => {
    midFile();
    expect((await getRetracted({ headers: { range: 'bytes=1-' } })).status).toBe(206);
    expect(h.getCoveredRetractedMedia).toHaveBeenCalledWith(7, 42);
    expect(h.getRetractedMedia).not.toHaveBeenCalled();
    expect(h.recordRetractedView).toHaveBeenCalledTimes(1);
    expect(h.recordRetractedView).toHaveBeenCalledWith(42, 7);
  });

  it('writes the row before storage is touched, so a range past the end is recorded too', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 416 }));
    expect((await getRetracted({ headers: { range: 'bytes=5-' } })).status).toBe(416);
    expect(h.recordRetractedView).toHaveBeenCalledTimes(1);
  });

  it('answers reported bytes, or a failed read, as a missing image', async () => {
    h.getCoveredRetractedMedia.mockResolvedValue('covered-refused');
    expect((await getRetracted()).status).toBe(404);
    expect(h.getRetractedMedia).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no bytes when the row is not written', async () => {
    h.recordRetractedView.mockRejectedValue(new Error('down'));
    const { status, res } = await getRetracted();
    expect(status).toBe(503);
    // The route answers its refusals as JSON: the message, not the image.
    expect(await res!.json()).toEqual({ message: 'Could not record this view.' });
  });

  it.each([
    ['a probe', { query: '?probe=1' }],
    ['HEAD', { method: 'HEAD' }],
  ])('answers %s with the refusal 404, reading nothing', async (_, opts) => {
    expect((await getRetracted(opts)).status).toBe(404);
    expect(h.getCoveredRetractedMedia).not.toHaveBeenCalled();
    expect(h.getRetractedMedia).not.toHaveBeenCalled();
  });

  it('falls back to the existing rules for an image it does not cover', async () => {
    h.getCoveredRetractedMedia.mockResolvedValue(null);
    h.getRetractedMedia.mockResolvedValue('needs-csam-queue');
    expect((await getRetracted()).status).toBe(403);
    expect(h.getRetractedMedia).toHaveBeenCalledWith(7, { csamReview: false });
  });

  it.each([
    ['switched off', false, new Set<string>()],
    ['the moderator has the CSAM page', true, new Set(['/images/csam'])],
  ])('is not read when %s', async (_, on, grants) => {
    h.coveredOn = on;
    h.grants = grants;
    expect((await getRetracted()).status).toBe(200);
    expect(h.getCoveredRetractedMedia).not.toHaveBeenCalled();
  });
});
