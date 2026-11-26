import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runs the REAL public/sw.js against a fake worker scope. The page HTML, API and image traffic must
 * never be touched by this worker: every case that asserts `respondWith` was not called is the
 * guarantee that online behavior is unchanged.
 */

const ORIGIN = 'https://civitai.test';
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');
const OFFLINE_HTML = fs.readFileSync(path.resolve(__dirname, '../../public/offline.html'), 'utf8');

type Listener = (event: any) => void;

function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const urlOf = (r: any) => (typeof r === 'string' ? r : r.url);
  const keyOf = (r: any) => new URL(urlOf(r), ORIGIN).href;
  const makeCache = (store: Map<string, Response>) => ({
    match: async (r: any) => store.get(keyOf(r))?.clone(),
    put: async (r: any, res: Response) => {
      store.delete(keyOf(r));
      store.set(keyOf(r), res);
    },
    delete: async (r: any) => store.delete(keyOf(r)),
    keys: async () => [...store.keys()].map((url) => ({ url })),
  });
  return {
    stores,
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return makeCache(stores.get(name)!);
    },
    match: async (r: any, opts?: { cacheName?: string }) => {
      for (const [name, store] of stores) {
        if (opts?.cacheName && opts.cacheName !== name) continue;
        const hit = store.get(keyOf(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

let sandbox: {
  listeners: Record<string, Listener>;
  caches: ReturnType<typeof fakeCacheStorage>;
  fetch: ReturnType<typeof vi.fn>;
  self: any;
};

function load() {
  const listeners: Record<string, Listener> = {};
  const caches = fakeCacheStorage();
  const fetchMock = vi.fn(async (_input: unknown) => new Response(OFFLINE_HTML, { status: 200 }));
  const self: any = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(), openWindow: vi.fn() },
    registration: {
      showNotification: vi.fn(async () => undefined),
      navigationPreload: { enable: vi.fn(async () => undefined) },
    },
  };
  sandbox = { listeners, caches, fetch: fetchMock, self };
  new Function('self', 'caches', 'fetch', SW_SOURCE)(self, caches, fetchMock);
}

function basic(
  body: string,
  status = 200,
  opts: { type?: string; redirected?: boolean; contentType?: string } = {}
) {
  const res = new Response(body, {
    status,
    headers: opts.contentType ? { 'content-type': opts.contentType } : undefined,
  });
  Object.defineProperty(res, 'type', { value: opts.type ?? 'basic' });
  if (opts.redirected) Object.defineProperty(res, 'redirected', { value: true });
  return res;
}

function request(
  url: string,
  init: { method?: string; mode?: string; accept?: string; range?: boolean } = {}
) {
  const headers = new Headers();
  if (init.accept) headers.set('accept', init.accept);
  if (init.range) headers.set('range', 'bytes=0-10');
  return {
    url: new URL(url, ORIGIN).href,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    headers,
  };
}

/** Fire an event through the worker; resolves with whether it answered, the answer, and waitUntil. */
async function fire(type: string, event: Record<string, any> = {}) {
  let answer: Promise<Response> | undefined;
  const waits: Promise<unknown>[] = [];
  sandbox.listeners[type]({
    ...event,
    respondWith: (p: Promise<Response>) => (answer = p),
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  return {
    handled: answer !== undefined,
    response: answer ? await answer : undefined,
    settle: () => Promise.all(waits),
    waits,
  };
}

const NAV = { mode: 'navigate', accept: 'text/html,application/xhtml+xml' };

beforeEach(() => {
  load();
});

describe('push handlers are still registered', () => {
  it('registers push, notificationclick and pushsubscriptionchange', () => {
    expect(Object.keys(sandbox.listeners)).toEqual(
      expect.arrayContaining(['push', 'notificationclick', 'pushsubscriptionchange'])
    );
  });

  it('push still shows the notification', async () => {
    const out = await fire('push', {
      data: { json: () => ({ title: 'T', body: 'B', url: '/x' }) },
    });
    await out.settle();
    expect(sandbox.self.registration.showNotification).toHaveBeenCalledWith(
      'T',
      expect.objectContaining({ body: 'B', data: { url: '/x' } })
    );
  });
});

describe('requests the worker must not touch', () => {
  it.each([
    ['a POST navigation', request('/models', { ...NAV, method: 'POST' })],
    ['a cross-origin navigation', request('https://other.test/', NAV)],
    ['a cross-origin static asset', request('https://cdn.test/_next/static/a.js')],
    // Downloads are top-level navigations with an HTML Accept header; they need Range/streaming.
    ['a download link navigation', request('/api/download/models/1', NAV)],
    ['a navigation that does not accept HTML', request('/img.png', { mode: 'navigate' })],
    ['a tRPC subresource fetch', request('/api/trpc/image.getInfinite')],
    ['a feed page-data fetch', request('/_next/data/abc/index.json')],
    ['an image-CDN request', request('/images/logo_dark_mode.png', { mode: 'no-cors' })],
    ['a ranged static request', request('/_next/static/a.js', { range: true })],
  ])('%s is not answered by the worker', async (_label, req) => {
    const out = await fire('fetch', { request: req });
    expect(out.handled).toBe(false);
  });
});

describe('navigation: network first, fallback only when the network fails', () => {
  it('returns the network response and caches nothing', async () => {
    sandbox.fetch.mockResolvedValueOnce(basic('<html>feed</html>'));
    const before = new Map([...sandbox.caches.stores].map(([k, v]) => [k, v.size]));
    const out = await fire('fetch', { request: request('/models', NAV) });
    expect(await out.response!.text()).toBe('<html>feed</html>');
    await out.settle();
    expect(new Map([...sandbox.caches.stores].map(([k, v]) => [k, v.size]))).toEqual(before);
  });

  it('passes an HTTP 500 through instead of showing the offline page', async () => {
    sandbox.fetch.mockResolvedValueOnce(basic('server broke', 500));
    const out = await fire('fetch', { request: request('/models', NAV) });
    expect(out.response!.status).toBe(500);
    expect(await out.response!.text()).toBe('server broke');
  });

  it('serves the cached offline page when the network is down', async () => {
    await fire('install').then((o) => o.settle());
    sandbox.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await fire('fetch', { request: request('/models', NAV) });
    expect(await out.response!.text()).toContain('id="retry"');
  });

  it('reads the offline page from its own cache, not any cache that has the URL', async () => {
    // Created before the install so the fake's insertion-order scan reaches it first.
    const other = await sandbox.caches.open('civitai-static-v1');
    await other.put('/offline.html', new Response('WRONG PAGE'));
    await fire('install').then((o) => o.settle());
    sandbox.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await fire('fetch', { request: request('/models', NAV) });
    expect(await out.response!.text()).toContain('id="retry"');
  });

  it('falls back to a network error (today’s behavior) when the offline page is missing', async () => {
    sandbox.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await fire('fetch', { request: request('/models', NAV) });
    expect(out.response!.type).toBe('error');
  });
});

describe('static asset cache', () => {
  const asset = () => request('/_next/static/chunks/a-abc123.js');
  const cachedUrls = () => [...(sandbox.caches.stores.get('civitai-static-v1')?.keys() ?? [])];

  it.each([
    ['an opaque 200', basic('x', 200, { type: 'opaque' })],
    ['a redirected 200', basic('x', 200, { redirected: true })],
    // Captive portals and proxies answer a chunk URL with their login page at 200.
    [
      'an HTML 200 (captive portal)',
      basic('<html>login</html>', 200, { contentType: 'text/html' }),
    ],
  ])('does not cache %s but still returns it', async (_label, res) => {
    sandbox.fetch.mockResolvedValue(res);
    const out = await fire('fetch', { request: asset() });
    expect(await out.response!.text()).toBeTruthy();
    await out.settle();
    expect(cachedUrls()).toEqual([]);
  });

  it('registers the cache write with waitUntil so the worker is not killed mid-write', async () => {
    sandbox.fetch.mockResolvedValue(basic('chunk'));
    const out = await fire('fetch', { request: asset() });
    expect(out.waits).toHaveLength(1);
  });

  it('still returns the network response when Cache Storage throws', async () => {
    const open = vi.spyOn(sandbox.caches, 'open').mockRejectedValue(new Error('storage fault'));
    sandbox.fetch.mockResolvedValue(basic('chunk'));
    const out = await fire('fetch', { request: asset() });
    expect(await out.response!.text()).toBe('chunk');
    open.mockRestore();
  });

  it('fetches once, then serves from cache without the network', async () => {
    sandbox.fetch.mockResolvedValue(basic('chunk'));
    const first = await fire('fetch', { request: asset() });
    expect(await first.response!.text()).toBe('chunk');
    await first.settle();
    sandbox.fetch.mockClear();
    const second = await fire('fetch', { request: asset() });
    expect(await second.response!.text()).toBe('chunk');
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it('does not cache a failed response', async () => {
    sandbox.fetch.mockResolvedValue(basic('gone', 404));
    const out = await fire('fetch', { request: asset() });
    await out.settle();
    expect([...(sandbox.caches.stores.get('civitai-static-v1')?.keys() ?? [])]).toEqual([]);
  });

  it('keeps at most 200 entries, dropping the oldest', async () => {
    sandbox.fetch.mockImplementation(async () => basic('x'));
    for (let i = 0; i < 205; i++) {
      const out = await fire('fetch', { request: request(`/_next/static/c${i}.js`) });
      await out.settle();
    }
    const urls = [...sandbox.caches.stores.get('civitai-static-v1')!.keys()];
    expect(urls).toHaveLength(200);
    expect(urls).not.toContain(`${ORIGIN}/_next/static/c0.js`);
    expect(urls).toContain(`${ORIGIN}/_next/static/c204.js`);
  });
});

describe('install and activate', () => {
  // DECISION: install must succeed even when the offline page cannot be cached, because push opt-in
  // waits on this worker becoming ready. Do not "fail closed" here without moving push off it.
  it.each([
    ['an HTTP 500', () => sandbox.fetch.mockResolvedValue(new Response('nope', { status: 500 }))],
    [
      'a redirected response (region redirect)',
      () =>
        sandbox.fetch.mockResolvedValue(basic('<html>blocked</html>', 200, { redirected: true })),
    ],
    ['a network failure', () => sandbox.fetch.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('install still succeeds and caches nothing on %s', async (_label, arrange) => {
    arrange();
    const out = await fire('install');
    await out.settle();
    expect(sandbox.caches.stores.get('civitai-shell-v1')?.size ?? 0).toBe(0);
    expect(sandbox.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('a good install caches the offline page and takes over without waiting for tabs to close', async () => {
    const out = await fire('install');
    await out.settle();
    expect([...sandbox.caches.stores.get('civitai-shell-v1')!.keys()]).toEqual([
      `${ORIGIN}/offline.html`,
    ]);
    expect(sandbox.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  // DECISION, not an oversight: navigation preload is per registration, so enabling it makes the
  // browser also preload the /api/ and non-HTML navigations this worker declines, then re-request
  // them. Measured in Chromium: GET /api/download/1 reached the server twice. Whoever deletes this
  // test to speed up page loads is re-introducing double-hit downloads and auth callbacks.
  it('never enables navigation preload', async () => {
    await fire('activate').then((o) => o.settle());
    expect(sandbox.self.registration.navigationPreload.enable).not.toHaveBeenCalled();
  });

  it('activate deletes caches from other versions, keeps current ones, claims clients', async () => {
    await sandbox.caches.open('civitai-shell-v0');
    await sandbox.caches.open('civitai-static-v0');
    await sandbox.caches.open('civitai-shell-v1');
    await sandbox.caches.open('civitai-static-v1');
    await fire('activate').then((o) => o.settle());
    expect([...sandbox.caches.stores.keys()].sort()).toEqual([
      'civitai-shell-v1',
      'civitai-static-v1',
    ]);
    expect(sandbox.self.clients.claim).toHaveBeenCalled();
  });
});

describe('offline.html', () => {
  it('is self-contained: no external requests and no app scripts', () => {
    // Offline there is nothing to load a second resource from: any of these would render broken.
    for (const loader of [
      /\ssrc=/i,
      /\ssrcset=/i,
      /<link\b/i,
      /<img\b/i,
      /<iframe\b/i,
      /@import/i,
      /url\(/i,
    ]) {
      expect(OFFLINE_HTML).not.toMatch(loader);
    }
  });

  it('has a Retry button that reloads the page', () => {
    expect(OFFLINE_HTML).toContain('id="retry"');
    expect(OFFLINE_HTML).toContain('location.reload()');
  });
});
