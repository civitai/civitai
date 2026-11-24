import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRACTED_UNAVAILABLE, retractedMediaUrl } from '$lib/held-media';

/**
 * `/api/retracted-media/[imageId]`: a blocked image from storage for a moderator. Eligibility is
 * pinned against real SQL in `retracted-media-eligibility.pglite.test.ts`; this file mocks it.
 */

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';

const getModeratorMedia = vi.hoisted(() => vi.fn());
const moderatorMediaUnavailable = vi.hoisted(() => vi.fn(async (_id: number) => false));
const recordRetractedView = vi.hoisted(() => vi.fn(async () => {}));
const recordHeldView = vi.hoisted(() => vi.fn(async () => {}));
const getGetUrl = vi.hoisted(() =>
  vi.fn(async (input: { key?: string }) => ({ url: `https://store.test/signed/${input.key}` }))
);
const grants = vi.hoisted(() => ({ paths: new Set<string>() }));
const enabled = vi.hoisted(() => ({ on: true }));

vi.mock('$lib/server/access', () => ({
  canAccess: (_user: unknown, path: string) => grants.paths.has(path),
}));
vi.mock('$lib/server/retracted-media', () => ({
  getModeratorMedia,
  moderatorMediaUnavailable,
  recordRetractedView,
  retractedMediaEnabled: () => enabled.on,
}));
const retryAfter = vi.hoisted(() => ({ seconds: null as number | null }));
const retractedMediaRetryAfter = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/retracted-media-rate', () => ({ retractedMediaRetryAfter }));
vi.mock('$lib/server/storage', () => ({ getStorage: () => ({ getGetUrl }) }));
vi.mock('$lib/server/held-media', () => ({
  HELD_MEDIA_PAGE: '/images/csam',
  holdsCsamReview: (_user: unknown) => grants.paths.has('/images/csam'),
  recordHeldView,
  recordHeldServe: () => undefined,
}));
vi.mock('$lib/server/held-sheet', () => ({ SHEET_IMAGE_TYPES: new Set(['image/jpeg']) }));

const { GET } = await import('../../../routes/api/retracted-media/[imageId]/+server');

const fetchMock = vi.fn();

async function call({
  user = { id: 42 } as { id: number } | null,
  imageId = '7',
  headers = {} as Record<string, string>,
  query = '',
} = {}): Promise<{ status: number; res?: Response }> {
  const url = new URL(`http://mod.test/api/retracted-media/${imageId}${query}`);
  try {
    const res = await GET({
      params: { imageId },
      url,
      request: new Request(url, { headers }),
      locals: { user, grants: {} },
    } as never);
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500 };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  grants.paths = new Set();
  enabled.on = true;
  getModeratorMedia.mockResolvedValue({
    url: KEY,
    type: 'image',
    mimeType: null,
    kind: 'retracted',
  });
  recordRetractedView.mockResolvedValue(undefined);
  fetchMock.mockImplementation(
    async () =>
      new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});
beforeEach(() => retractedMediaRetryAfter.mockImplementation(async () => retryAfter.seconds));
afterEach(() => vi.unstubAllGlobals());

describe('/api/retracted-media', () => {
  it('refuses a request with no moderator behind it, before reading the image', async () => {
    expect((await call({ user: null })).status).toBe(403);
    expect(getModeratorMedia).not.toHaveBeenCalled();
  });

  it('answers every refusal no-store', async () => {
    getModeratorMedia.mockResolvedValue(null);
    for (const opts of [{ user: null }, { imageId: 'x' }, {}]) {
      const { status, res } = await call(opts);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(res?.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('answers 404, no-store, before anything else while switched off', async () => {
    enabled.on = false;
    const { status, res } = await call();
    expect(status).toBe(404);
    expect(res?.headers.get('cache-control')).toBe('private, no-store');
    expect(getModeratorMedia).not.toHaveBeenCalled();
  });

  it('answers a probe with eligibility alone: no storage, no audit row', async () => {
    const { status } = await call({ query: '?probe=1' });
    expect(status).toBe(204);
    expect(getGetUrl).not.toHaveBeenCalled();
    expect(recordRetractedView).not.toHaveBeenCalled();
  });

  it('refuses a bad id', async () => {
    expect((await call({ imageId: 'x' })).status).toBe(400);
    expect((await call({ imageId: String(2 ** 31) })).status).toBe(400);
    expect(getModeratorMedia).not.toHaveBeenCalled();
  });

  it('asks for the CSAM-review tier only with the CSAM page grant', async () => {
    await call();
    expect(getModeratorMedia).toHaveBeenLastCalledWith(7, { csamReview: false });
    grants.paths = new Set(['/images/csam']);
    await call();
    expect(getModeratorMedia).toHaveBeenLastCalledWith(7, { csamReview: true });
  });

  it('refuses an image it may not serve, and never touches storage', async () => {
    getModeratorMedia.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(getGetUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A probe is told the file is gone only when no moderator could be served it; anything else
  // refused reads the same, so a withheld image is not told apart from a missing grant.
  it('tells a refused probe the file is unavailable only when no moderator could be served it', async () => {
    getModeratorMedia.mockResolvedValue(null);
    const message = async (query: string) =>
      ((await (await call({ query })).res?.json()) as { message?: string } | undefined)?.message;
    moderatorMediaUnavailable.mockResolvedValue(true);
    expect(await message('?probe=1')).toBe(RETRACTED_UNAVAILABLE);
    expect(await message('')).not.toBe(RETRACTED_UNAVAILABLE);
    moderatorMediaUnavailable.mockResolvedValue(false);
    expect(await message('?probe=1')).not.toBe(RETRACTED_UNAVAILABLE);
    moderatorMediaUnavailable.mockRejectedValue(new Error('down'));
    expect(await message('?probe=1')).not.toBe(RETRACTED_UNAVAILABLE);
  });

  it('serves held media to a moderator with the CSAM page grant, audited as a held view', async () => {
    grants.paths = new Set(['/images/csam']);
    getModeratorMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null, kind: 'held' });
    const { status } = await call();
    expect(status).toBe(200);
    expect(recordHeldView).toHaveBeenCalledWith(42, 7, 'web');
    expect(recordRetractedView).not.toHaveBeenCalled();
  });

  it('answers a probe for held media with eligibility alone: no storage, no audit row', async () => {
    grants.paths = new Set(['/images/csam']);
    getModeratorMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null, kind: 'held' });
    expect((await call({ query: '?probe=1' })).status).toBe(204);
    expect(getGetUrl).not.toHaveBeenCalled();
    expect(recordHeldView).not.toHaveBeenCalled();
  });

  it('streams the stored file, keyed by the row, no-store, after its audit row', async () => {
    const { status, res } = await call();
    expect(status).toBe(200);
    expect(await res!.text()).toBe('bytes');
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
    expect(getGetUrl).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, expiresIn: 60 }));
    expect(recordRetractedView).toHaveBeenCalledWith(42, 7);
  });

  it('audits a mid-file range too', async () => {
    fetchMock.mockResolvedValue(
      new Response('ytes', {
        status: 206,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '4',
          'content-range': 'bytes 1-4/5',
        },
      })
    );
    expect((await call({ headers: { range: 'bytes=1-4' } })).status).toBe(206);
    expect(recordRetractedView).toHaveBeenCalledWith(42, 7);
  });

  it('sends nothing when the audit row cannot be written', async () => {
    recordRetractedView.mockRejectedValue(new Error('down'));
    expect((await call()).status).toBe(503);
  });

  it('refuses an object over the size cap, and one with no declared length', async () => {
    fetchMock.mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(300 * 1024 * 1024) },
      })
    );
    expect((await call()).status).toBe(413);
    fetchMock.mockResolvedValue(
      new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );
    expect((await call()).status).toBe(413);
    expect(recordRetractedView).not.toHaveBeenCalled();
  });
});

describe('/api/retracted-media, held media for a moderator without the CSAM grant', () => {
  beforeEach(() => {
    getModeratorMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null, kind: 'held' });
  });

  // civitai/civitai#10202: the answer must not tell held media apart from retracted media.
  it('answers as for retracted media, audited as a held view', async () => {
    expect((await call()).status).toBe(200);
    expect(recordHeldView).toHaveBeenCalledWith(42, 7, 'web');
    fetchMock.mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(300 * 1024 * 1024) },
      })
    );
    expect((await call()).status).toBe(413);
  });
});

describe('/api/retracted-media, held media for a moderator with the CSAM grant', () => {
  it('serves a held file over the cap, audited as a held view', async () => {
    grants.paths = new Set(['/images/csam']);
    getModeratorMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: null, kind: 'held' });
    fetchMock.mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(300 * 1024 * 1024) },
      })
    );
    expect((await call()).status).toBe(200);
    expect(recordHeldView).toHaveBeenCalledWith(42, 7, 'web');
  });
});

describe('/api/retracted-media eligibility read failure', () => {
  it('answers 503, no-store, and touches no storage', async () => {
    getModeratorMedia.mockRejectedValue(new Error('canceling statement due to statement timeout'));
    const { status, res } = await call();
    expect(status).toBe(503);
    expect(res?.headers.get('cache-control')).toBe('private, no-store');
    expect(getGetUrl).not.toHaveBeenCalled();
  });
});

describe('/api/retracted-media rate limit', () => {
  it('answers 429 with retry-after and no-store over the limit, before reading the image', async () => {
    retryAfter.seconds = 42;
    try {
      const { status, res } = await call();
      expect(status).toBe(429);
      expect(res?.headers.get('retry-after')).toBe('42');
      expect(res?.headers.get('cache-control')).toBe('private, no-store');
      expect(getModeratorMedia).not.toHaveBeenCalled();
      expect(retractedMediaRetryAfter).toHaveBeenCalledWith(42);
    } finally {
      retryAfter.seconds = null;
    }
  });
});

describe('retractedMediaUrl', () => {
  // The queue tiles build this url by hand; a moved route would leave every fallback a 404.
  it('names this route', () => {
    expect(retractedMediaUrl(7)).toBe('/api/retracted-media/7');
    const route = new URL(
      '../../../routes/api/retracted-media/[imageId]/+server.ts',
      import.meta.url
    );
    expect(existsSync(route)).toBe(true);
  });
});
