import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaForToken = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/scan-label.service', () => ({ mediaForToken }));
const publicEnv = vi.hoisted(() => ({
  PUBLIC_IMAGE_LOCATION: 'https://cdn.test' as string | undefined,
}));
vi.mock('$env/dynamic/public', () => ({ env: publicEnv }));

const { GET } = await import('../+server');
const { getEdgeUrl, getVideoUrls } = await import('$lib/media/edge-url');

const TOKEN = '00000000-0000-4000-8000-000000000005';
const IMAGE = { url: 'media-key-x7', type: 'image', name: 'upload-name.png' };
const VIDEO = { url: 'media-key-v9', type: 'video', name: 'clip.mp4' };

const upstream = (status: number, headers: Record<string, string> = {}) =>
  new Response('bytes', { status, headers });

function call({
  token = TOKEN,
  user = { id: 7 } as unknown,
  query = '',
  headers = {} as Record<string, string>,
  method = 'GET',
  fetch = vi.fn(async () => upstream(200, { 'content-type': 'image/webp' })),
} = {}) {
  const url = new URL(`https://moderator.test/images/scan-labels/media/${token}${query}`);
  const res = GET({
    params: { token },
    url,
    locals: { user },
    request: new Request(url, { headers, method }),
    fetch,
  } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
  return { res, fetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  publicEnv.PUBLIC_IMAGE_LOCATION = 'https://cdn.test';
  mediaForToken.mockResolvedValue(IMAGE);
});

describe('GET /images/scan-labels/media/[token]', () => {
  it('streams the held card through its own token and user', async () => {
    const { res, fetch } = call();
    const r = await res;
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('bytes');
    expect(mediaForToken).toHaveBeenCalledExactlyOnceWith(TOKEN, 7);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('media-key-x7');
  });

  it('answers 404 with an empty body when the token is not a live claim of this moderator', async () => {
    mediaForToken.mockResolvedValue(null);
    const { res, fetch } = call();
    const r = await res;
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 404 for a token that is not a uuid, without looking it up', async () => {
    const { res, fetch } = call({ token: 'not-a-token' });
    expect((await res).status).toBe(404);
    expect(mediaForToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a request with no moderator session', async () => {
    const { res } = call({ user: null });
    expect((await res).status).toBe(401);
    expect(mediaForToken).not.toHaveBeenCalled();
  });

  it('passes a range through and returns the partial content for a video', async () => {
    mediaForToken.mockResolvedValue(VIDEO);
    const fetch = vi.fn(async () =>
      upstream(206, {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-4/100',
        'accept-ranges': 'bytes',
      })
    );
    const r = await call({ query: '?v=mp4', headers: { range: 'bytes=0-4' }, fetch }).res;
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-4/100');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('range')).toBe('bytes=0-4');
  });

  it('sends only the playback headers, never one that names the upstream object', async () => {
    const fetch = vi.fn(async () =>
      upstream(200, {
        'content-type': 'image/webp',
        'content-length': '5',
        etag: '"media-key-x7"',
        link: '<https://cdn.test/media-key-x7>; rel=canonical',
        'content-disposition': 'inline; filename="upload-name.png"',
        'x-served-by': 'cdn',
      })
    );
    const r = await call({ fetch }).res;
    expect([...r.headers.keys()].sort()).toEqual([
      'cache-control',
      'content-length',
      'content-type',
    ]);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 502 when the CDN fails, without its body, and releases the upstream body', async () => {
    const body = upstream(500, { 'content-type': 'text/plain' });
    const cancel = vi.spyOn(body.body!, 'cancel');
    const r = await call({ fetch: vi.fn(async () => body) }).res;
    expect(r.status).toBe(502);
    expect(await r.text()).toBe('');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('answers 502 when the CDN cannot be reached', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await call({ fetch }).res).status).toBe(502);
  });

  it('passes an unsatisfiable range answer through', async () => {
    mediaForToken.mockResolvedValue(VIDEO);
    const fetch = vi.fn(async () => upstream(416, { 'content-range': 'bytes */100' }));
    const r = await call({ query: '?v=mp4', headers: { range: 'bytes=200-' }, fetch }).res;
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */100');
  });

  // The variants the page asked for before the route existed: 1200 wide, scaled down, animated.
  it.each([
    [
      IMAGE,
      '',
      getEdgeUrl(IMAGE.url, {
        width: 1200,
        fit: 'scale-down',
        anim: true,
        type: 'image',
        name: IMAGE.name,
      }),
    ],
    [
      IMAGE,
      '?v=mp4',
      getEdgeUrl(IMAGE.url, {
        width: 1200,
        fit: 'scale-down',
        anim: true,
        type: 'image',
        name: IMAGE.name,
      }),
    ],
    [
      VIDEO,
      '?v=mp4',
      getVideoUrls(VIDEO.url, { width: 1200, fit: 'scale-down', name: VIDEO.name }).mp4,
    ],
    [
      VIDEO,
      '?v=webm',
      getVideoUrls(VIDEO.url, { width: 1200, fit: 'scale-down', name: VIDEO.name }).webm,
    ],
    [
      VIDEO,
      '?v=poster',
      getVideoUrls(VIDEO.url, { width: 1200, fit: 'scale-down', name: VIDEO.name }).poster,
    ],
    [
      VIDEO,
      '?v=junk',
      getVideoUrls(VIDEO.url, { width: 1200, fit: 'scale-down', name: VIDEO.name }).mp4,
    ],
  ])('fetches the variant the page used to load (%o %s)', async (media, query, expected) => {
    mediaForToken.mockResolvedValue(media);
    const { res, fetch } = call({ query });
    await res;
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(expected);
    expect(expected).toContain('width=1200');
  });

  it('forwards the browser Accept so the CDN negotiates the same format', async () => {
    const { res, fetch } = call({ headers: { accept: 'image/avif,image/webp,*/*' } });
    await res;
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('accept')).toBe('image/avif,image/webp,*/*');
  });

  // Keys getEdgeUrl passes through as they are, which would otherwise be fetched from here.
  it.each(['https://elsewhere.test/x.png', 'httpfoo', 'blob-key', ''])(
    'fetches nothing but the CDN (key %j)',
    async (key) => {
      mediaForToken.mockResolvedValue({ ...IMAGE, url: key });
      const { res, fetch } = call();
      expect((await res).status).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('fetches nothing when the CDN base is not configured', async () => {
    publicEnv.PUBLIC_IMAGE_LOCATION = undefined;
    mediaForToken.mockResolvedValue({ ...IMAGE, url: '//elsewhere.test/x' });
    const { res, fetch } = call();
    expect((await res).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a path-like key on the CDN host', async () => {
    mediaForToken.mockResolvedValue({ ...IMAGE, url: '//elsewhere.test/x' });
    const { res, fetch } = call();
    expect((await res).status).toBe(200);
    expect(new URL(String((fetch.mock.calls[0] as unknown[])[0])).origin).toBe('https://cdn.test');
  });

  it('drops the length of an encoded response, which fetch has already decoded', async () => {
    const fetch = vi.fn(async () =>
      upstream(200, {
        'content-type': 'image/webp',
        'content-length': '3',
        'content-encoding': 'br',
      })
    );
    const r = await call({ fetch }).res;
    expect(r.headers.has('content-length')).toBe(false);
  });

  it('answers HEAD with the headers only, releasing the upstream body', async () => {
    const body = upstream(200, { 'content-type': 'image/webp', 'content-length': '5' });
    const cancel = vi.spyOn(body.body!, 'cancel');
    const r = await call({ method: 'HEAD', fetch: vi.fn(async () => body) }).res;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('5');
    expect(r.body).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
