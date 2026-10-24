import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HeldMediaModule from '../held-media';

/**
 * `/api/held-media/[imageId]`: CSAM-queue media from storage, past the public CDN. What it must never
 * become is a general way past the CDN or a proxy for a key the browser picks. Which rows are eligible
 * is pinned against real SQL in `held-media-eligibility.pglite.test.ts`; this file mocks that lookup.
 */

const KEY = '0b9f5a4e-1d2c-4e3f-8a7b-6c5d4e3f2a1b';

const getHeldMedia = vi.hoisted(() =>
  vi.fn(
    async (_id: number) =>
      ({ url: KEY, type: 'image', mimeType: null as string | null } as {
        url: string;
        type: string;
        mimeType: string | null;
      } | null)
  )
);
const getGetUrl = vi.hoisted(() =>
  vi.fn(async (input: { backend: string; key?: string }) => ({
    url: `https://store.test/signed/${input.key}`,
    bucket: 'b',
    key: input.key ?? '',
  }))
);
const recordModActivity = vi.hoisted(() => vi.fn(async () => {}));
const grants = vi.hoisted(() => ({ paths: new Set<string>(['/images/csam']) }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/access', async () => {
  const { error } = await import('@sveltejs/kit');
  const canAccess = (_user: unknown, path: string) => grants.paths.has(path);
  return {
    canAccess,
    requireAccess: (user: unknown, path: string) => {
      if (!canAccess(user, path)) error(403, 'no');
    },
  };
});
vi.mock('$lib/server/held-media', async (importOriginal) => ({
  ...(await importOriginal<typeof HeldMediaModule>()),
  getHeldMedia,
}));
vi.mock('$lib/server/storage', () => ({ getStorage: () => ({ getGetUrl }) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));

const { GET } = await import('../../../routes/api/held-media/[imageId]/+server');
const { POST } = await import('../../../routes/api/held-media/grid-view/+server');

const fetchMock = vi.fn();

function upstream(status: number, headers: Record<string, string> = {}, body = 'bytes') {
  return new Response(status === 416 ? null : body, { status, headers });
}

async function call(
  path = '/api/held-media/7',
  headers: Record<string, string> = {},
  imageId = '7'
): Promise<{ status: number; res?: Response }> {
  const url = new URL(`http://mod.test${path}`);
  try {
    const res = await GET({
      params: { imageId },
      url,
      request: new Request(url, { headers }),
      locals: { user: { id: 42, roles: ['moderator:staff'] }, grants: {} },
    } as never);
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500 };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  grants.paths = new Set(['/images/csam']);
  getHeldMedia.mockImplementation(async () => ({ url: KEY, type: 'image', mimeType: null }));
  fetchMock.mockResolvedValue(
    upstream(200, { 'content-type': 'image/jpeg', 'content-length': '5' })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('access', () => {
  it('refuses without the CSAM queue grant, before reading the image', async () => {
    grants.paths = new Set(['/images/minor']);
    expect((await call()).status).toBe(403);
    expect(getHeldMedia).not.toHaveBeenCalled();
    expect(getGetUrl).not.toHaveBeenCalled();
  });

  it('refuses an image that is not held, the same as a missing one, and never touches storage', async () => {
    getHeldMedia.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(getGetUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a row whose url is not a storage key', async () => {
    getHeldMedia.mockResolvedValue({
      url: 'https://elsewhere.test/x.png',
      type: 'image',
      mimeType: null,
    });
    expect((await call()).status).toBe(404);
    expect(getGetUrl).not.toHaveBeenCalled();
  });

  it('fetches the key from the row, whatever key or url the request names', async () => {
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await call(`/api/held-media/7?key=${other}&url=https://evil.test/x&backend=csam&bucket=x`);
    expect(getHeldMedia).toHaveBeenCalledWith(7);
    expect(getGetUrl).toHaveBeenCalledTimes(1);
    expect(getGetUrl.mock.calls[0][0]).toEqual({ backend: 'b2Image', key: KEY, expiresIn: 60 });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://store.test/signed/${KEY}`);
  });
});

describe('response', () => {
  it('serves an allowed image inline, private and unsniffable, streaming the body', async () => {
    const { status, res } = await call();
    expect(status).toBe(200);
    expect(Object.fromEntries(res!.headers)).toMatchObject({
      'content-type': 'image/jpeg',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'accept-ranges': 'bytes',
      'content-length': '5',
    });
    expect(await res!.text()).toBe('bytes');
  });

  it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml'])(
    'serves %s as an opaque download type, never something a browser renders',
    async (type) => {
      fetchMock.mockResolvedValue(upstream(200, { 'content-type': type }));
      const { res } = await call();
      expect(res!.headers.get('content-type')).toBe('application/octet-stream');
    }
  );

  it('uses the row mime type when the store sends a generic one', async () => {
    getHeldMedia.mockResolvedValue({ url: KEY, type: 'image', mimeType: 'image/webp' });
    fetchMock.mockResolvedValue(upstream(200, { 'content-type': 'binary/octet-stream' }));
    expect((await call()).res!.headers.get('content-type')).toBe('image/webp');
  });

  it('streams a browser-playable video and refuses any other, with no download', async () => {
    getHeldMedia.mockResolvedValue({ url: KEY, type: 'video', mimeType: 'video/mp4' });
    fetchMock.mockResolvedValue(upstream(200, { 'content-type': 'video/mp4' }));
    expect((await call()).res!.headers.get('content-type')).toBe('video/mp4');

    getHeldMedia.mockResolvedValue({ url: KEY, type: 'video', mimeType: 'video/quicktime' });
    fetchMock.mockResolvedValue(upstream(200, { 'content-type': 'video/quicktime' }));
    expect((await call()).status).toBe(415);
  });

  it('forwards a Range and answers 206 with the content range', async () => {
    fetchMock.mockResolvedValue(
      upstream(206, { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-4/100' })
    );
    const { status, res } = await call('/api/held-media/7', { range: 'bytes=0-4' });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('range')).toBe('bytes=0-4');
    expect(status).toBe(206);
    expect(res!.headers.get('content-range')).toBe('bytes 0-4/100');
  });

  it('drops a multi-range header rather than forwarding it', async () => {
    await call('/api/held-media/7', { range: 'bytes=0-1,5-9' });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('range')).toBeNull();
  });

  it.each([
    [404, 404],
    [403, 502],
    [500, 502],
    [503, 502],
  ])('maps a store %i to %i', async (from, to) => {
    fetchMock.mockResolvedValue(upstream(from));
    expect((await call()).status).toBe(to);
  });

  it('answers an unsatisfiable range empty, without the store error body length', async () => {
    const xml = '<Error><Code>InvalidRange</Code></Error>';
    const res416 = new Response(xml, {
      status: 416,
      headers: { 'content-length': String(xml.length), 'content-range': 'bytes */100' },
    });
    fetchMock.mockResolvedValue(res416);
    const { status, res } = await call('/api/held-media/7', { range: 'bytes=500-' });
    expect(status).toBe(416);
    expect(res!.headers.get('content-length')).toBeNull();
    expect(res!.headers.get('content-range')).toBe('bytes */100');
    expect(res416.bodyUsed || res416.body?.locked).toBe(true);
  });

  it('drops the stored length of a content-encoded object, which fetch decodes', async () => {
    fetchMock.mockResolvedValue(
      upstream(200, {
        'content-type': 'image/png',
        'content-encoding': 'gzip',
        'content-length': '3',
      })
    );
    expect((await call()).res!.headers.get('content-length')).toBeNull();
  });

  it('maps an unreachable store to 502', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect((await call()).status).toBe(502);
    getGetUrl.mockRejectedValueOnce(new Error('storage down'));
    expect((await call()).status).toBe(502);
  });
});

describe('audit', () => {
  it('records one row per full view, not per grid image or per seek', async () => {
    await call('/api/held-media/7?view=full');
    await call('/api/held-media/7?view=full', { range: 'bytes=0-' });
    await call('/api/held-media/7?view=full', { range: 'bytes=5000-' });
    await call('/api/held-media/7');
    expect(recordModActivity.mock.calls).toEqual([
      [{ userId: 42, entityType: 'image', entityId: 7, activity: 'heldMedia:view' }],
      [{ userId: 42, entityType: 'image', entityId: 7, activity: 'heldMedia:view' }],
    ]);
  });

  it('records no view of an image it refused', async () => {
    getHeldMedia.mockResolvedValue(null);
    await call('/api/held-media/7?view=full');
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('counts one full view for Safari, whose first request is a two-byte probe', async () => {
    await call('/api/held-media/7?view=full', { range: 'bytes=0-1' });
    await call('/api/held-media/7?view=full', { range: 'bytes=0-99' });
    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });

  const gridView = async (body: unknown) => {
    try {
      const res = await POST({
        request: new Request('http://mod.test/api/held-media/grid-view', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        locals: { user: { id: 42, roles: ['moderator:staff'] }, grants: {} },
      } as never);
      return res.status;
    } catch (e) {
      return (e as { status?: number }).status ?? 500;
    }
  };

  it('records one grid row with the count and no image ids', async () => {
    expect(await gridView({ count: 3, imageIds: [1, 2, 3] })).toBe(204);
    expect(recordModActivity.mock.calls).toEqual([
      [{ userId: 42, entityType: 'heldMediaGrid', entityId: 3, activity: 'heldMedia:grid' }],
    ]);
  });

  it('refuses a grid row without the grant, or with a count that is not one', async () => {
    grants.paths = new Set(['/images/minor']);
    expect(await gridView({ count: 3 })).toBe(403);
    grants.paths = new Set(['/images/csam']);
    for (const count of [0, -1, 2.5, '3', 100_000]) expect(await gridView({ count })).toBe(400);
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});
