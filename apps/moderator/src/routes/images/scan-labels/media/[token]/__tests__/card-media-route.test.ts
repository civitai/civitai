import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaForToken = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/scan-label.service', () => ({ mediaForToken }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_IMAGE_LOCATION: 'https://cdn.test' } }));

const { GET } = await import('../+server');

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
  fetch = vi.fn(async () => upstream(200, { 'content-type': 'image/webp' })),
} = {}) {
  const url = new URL(`https://moderator.test/images/scan-labels/media/${token}${query}`);
  const res = GET({
    params: { token },
    url,
    locals: { user },
    request: new Request(url, { headers }),
    fetch,
  } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
  return { res, fetch };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('answers 502 when the CDN fails, without its body', async () => {
    const fetch = vi.fn(async () => upstream(500, { 'content-type': 'text/plain' }));
    const r = await call({ fetch }).res;
    expect(r.status).toBe(502);
    expect(await r.text()).toBe('');
  });
});
