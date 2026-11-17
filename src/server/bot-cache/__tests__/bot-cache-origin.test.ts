import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BotCache from '~/server/bot-cache/bot-cache';
import type * as FliptClient from '~/server/flipt/client';
import type * as ShellResponse from '~/server/shell/shell-response';
import type * as Zlib from 'zlib';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The proxy half of the bot HTML origin cache: a stored render is served only to a request
 * `botCacheRefusal` allows. Every refusal case starts from a request that IS served (the first
 * test) and changes one fact, with the entry that request would read already in the store, so a
 * case can only stay unserved because the request was refused.
 */

const h = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return { flagOn: true, buildId: 'build-a', predicateThrows: false };
});

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => ({})),
  isFliptSync: vi.fn((key: string) => (key === 'bot-html-edge-cache' && h.flagOn ? true : null)),
}));

vi.mock('~/server/bot-cache/bot-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof BotCache>();
  return {
    ...actual,
    botCacheRefusal: (...args: Parameters<typeof actual.botCacheRefusal>) => {
      if (h.predicateThrows) throw new Error('predicate down');
      return actual.botCacheRefusal(...args);
    },
  };
});

vi.mock('~/server/shell/shell-response', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellResponse>()),
  shellBuildId: () => h.buildId,
}));

// The real codec, counted: a store calls it synchronously inside `res.end`, so a store not started
// by the time `res.end` returns never will be, and a test can say "not stored" without a wait.
vi.mock('zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof Zlib & { default?: typeof Zlib }>();
  const real = actual.default ?? actual;
  const brotliCompress = vi.fn(real.brotliCompress);
  return { ...actual, brotliCompress, default: { ...real, brotliCompress } };
});

import { resetBotCacheFlagGateForTests } from '~/server/bot-cache/bot-cache';
import type { BotCacheEntry } from '~/server/bot-cache/bot-cache-origin';
import {
  botCacheKey,
  captureBotCacheRender,
  storeBotCacheRender,
} from '~/server/bot-cache/bot-cache-origin';
import { botCacheCandidatePattern } from '~/server/bot-cache/bot-cache-routes';
import { botCacheMiddleware } from '~/server/middleware/bot-cache.middleware';
import { runMiddlewares } from '~/server/middleware/index';
import { BOT_CACHE_LOOKUP_FAILED } from '~/shared/constants/bot-cache.constants';
import zlib from 'zlib';

const brotliCompress = vi.mocked(zlib.brotliCompress);

const SECRET = 'bot-cache-origin-secret-5d1e';
const IMAGE_ROUTE = '/images/[imageId]';
const HTML = '<!DOCTYPE html><html><body><main>stored image 1 é</main></body></html>';
const STORED_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
};

const store = new Map<string, unknown>();

/** The key under the current build id; throws when there is none. */
function keyFor(host: string, pathname: string, search = '', userAgent?: string) {
  const key = botCacheKey(host, pathname, search, userAgent);
  if (!key) throw new Error('no key: the build id is the fallback');
  return key;
}

function crawler(url = 'https://civitai.com/images/1', headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    headers: {
      host: new URL(url).host,
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'cf-ipcountry': 'US',
      'x-civ-cf-verified-bot': SECRET,
      ...headers,
    },
  });
}

/** What the store path writes for `url` (host, path and query as the render would read them). */
async function seed(url = 'https://civitai.com/images/1', pattern: string = IMAGE_ROUTE) {
  const { host, pathname, search } = new URL(url);
  await storeBotCacheRender(
    keyFor(host, pathname, search),
    pattern as never,
    STORED_HEADERS,
    Buffer.from(HTML)
  );
  expect(store.size, 'the entry is in the store').toBeGreaterThan(0);
}

const serve = (request: NextRequest) => runMiddlewares(request, [botCacheMiddleware]);

async function expectServed(response: Response) {
  expect(response.headers.get('x-civ-bot-cache')).toBe('hit');
  expect(response.headers.get('x-middleware-next')).toBeNull();
  expect(await response.text()).toBe(HTML);
}

function expectRendered(response: Response) {
  expect(response.headers.get('x-civ-bot-cache')).not.toBe('hit');
  expect(response.headers.get('x-middleware-next')).toBe('1');
}

beforeEach(() => {
  resetEnv();
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
  h.flagOn = true;
  h.buildId = 'build-a';
  h.predicateThrows = false;
  resetBotCacheFlagGateForTests();
  store.clear();
  brotliCompress.mockClear();
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
    return 'OK';
  });
  redisMock.redis.packed.get.mockImplementation(async (key: string) => store.get(key) ?? null);
});

describe('botCacheKey', () => {
  it('is build, device class, host, path and the sorted query', () => {
    expect(botCacheKey('civitai.com', '/images/1', '?b=2&a=1&a=0', undefined)).toBe(
      'botcache:v1:build-a:d:civitai.com:/images/1?a=0&a=1&b=2'
    );
    expect(botCacheKey('Civitai.COM', '/images/1', '', undefined, 'build-b')).toBe(
      'botcache:v1:build-b:d:civitai.com:/images/1?'
    );
  });

  it('keeps the smartphone crawler apart from the desktop one', () => {
    const phone =
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) Chrome/142.0 Mobile Safari/537.36 (compatible; Googlebot/2.1)';
    expect(botCacheKey('civitai.com', '/models/1', '', phone)).toBe(
      'botcache:v1:build-a:m:civitai.com:/models/1?'
    );
  });
});

describe('botCacheCandidatePattern', () => {
  it.each([
    ['/models/4201', '/models/[id]/[[...slug]]'],
    ['/models/4201/a-slug', '/models/[id]/[[...slug]]'],
    ['/images/1', '/images/[imageId]'],
    ['/posts/9/a-slug', '/posts/[postId]/[[...postSlug]]'],
    ['/articles/4/a-slug', '/articles/[id]/[[...slug]]'],
    ['/user/bob', '/user/[username]'],
    ['/user/bob/models', '/user/[username]/models'],
    ['/user/bob/sticker-book', '/user/[username]/sticker-book'],
    ['/user/bob/likes', '/user/[username]/[list]'],
  ])('%s reads as %s', (path, pattern) => {
    expect(botCacheCandidatePattern(path)).toBe(pattern);
  });

  it.each(['/', '/models', '/images', '/user', '/user/bob/a/b', '/images/1/extra', '/api/x'])(
    '%s is none of them',
    (path) => {
      expect(botCacheCandidatePattern(path)).toBeNull();
    }
  );
});

describe('serving a stored render', () => {
  it('serves the stored bytes and headers, no cookie, and a hit header', async () => {
    await seed();
    const response = await serve(crawler());
    await expectServed(response);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
    expect(response.headers.get('Cache-Tag')).toBeNull();
  });

  it('a miss renders, marked as a miss', async () => {
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe('miss');
  });

  it('a different build id misses the entry an earlier build stored', async () => {
    await seed();
    h.buildId = 'build-b';
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe('miss');
  });
});

describe('never served to a request botCacheRefusal refuses, though its entry exists', () => {
  it.each<[string, string, Record<string, string>]>([
    ['a cookie', 'https://civitai.com/images/1', { cookie: 'civitai-consent=accepted' }],
    ['an Authorization header', 'https://civitai.com/images/1', { authorization: 'Bearer key' }],
    ['a token param', 'https://civitai.com/images/1?token=abc', {}],
    ['the wrong secret', 'https://civitai.com/images/1', { 'x-civ-cf-verified-bot': 'guess' }],
    ['the civitai.red host', 'https://civitai.red/images/1', {}],
    ['a blocked region', 'https://civitai.com/images/1', { 'cf-ipcountry': 'GB' }],
  ])('%s', async (_, url, headers) => {
    await seed(url);
    const response = await serve(crawler(url, headers));
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBeNull();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });

  it('the flag off', async () => {
    await seed();
    h.flagOn = false;
    resetBotCacheFlagGateForTests();
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBeNull();
  });

  it('INVARIANT GUARD: an entry stored under a non-allowlisted pattern is not served', async () => {
    // Production never stores one: only a render `botCacheResponseRefusal` allows is captured, and
    // it needs an allowlisted pattern. This pins the check against the entry's own pattern, which
    // is all that stands between a path that READS as `[list]` and a page that is not.
    const url = 'https://civitai.com/user/bob/manage-categories';
    await seed(url, '/user/[username]/manage-categories');
    const response = await serve(crawler(url));
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe('miss');
  });

  it('a path that can be no allowlisted route', async () => {
    await seed('https://civitai.com/images', IMAGE_ROUTE);
    const response = await serve(crawler('https://civitai.com/images'));
    expectRendered(response);
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });
});

describe('a failed lookup renders', () => {
  it('a redis error', async () => {
    await seed();
    redisMock.redis.packed.get.mockRejectedValue(new Error('connection reset'));
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe(BOT_CACHE_LOOKUP_FAILED);
  });

  it('a lookup that never answers is abandoned after the 25 ms cap', async () => {
    await seed();
    redisMock.redis.packed.get.mockImplementation(() => new Promise<never>(() => undefined));
    const startedAt = performance.now();
    const response = await serve(crawler());
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe(BOT_CACHE_LOOKUP_FAILED);
  });

  it('an entry that does not decode', async () => {
    await seed();
    const [key, entry] = [...store.entries()][0]!;
    store.set(key, { ...(entry as BotCacheEntry), body: Buffer.from('not brotli') });
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBe('miss');
  });
});

describe('storing', () => {
  it('skips a page whose compressed HTML is over 256 KB', async () => {
    // Random bytes do not compress, so 300 KB of them stays over the cap.
    const html = Buffer.from(
      Array.from({ length: 300 * 1024 }, () => Math.floor(Math.random() * 256))
    );
    await storeBotCacheRender(keyFor('civitai.com', '/images/1'), IMAGE_ROUTE as never, {}, html);
    expect(store.size).toBe(0);
    // INSTRUMENT CHECK: a page under the cap is stored by the same call.
    await storeBotCacheRender(
      keyFor('civitai.com', '/images/1'),
      IMAGE_ROUTE as never,
      {},
      Buffer.from(HTML)
    );
    expect(store.size).toBe(1);
  });

  it('stores for 300 s', async () => {
    await seed();
    expect(redisMock.redis.packed.set).toHaveBeenCalledWith(
      'botcache:v1:build-a:d:civitai.com:/images/1?',
      expect.objectContaining({ pattern: IMAGE_ROUTE }),
      { EX: 300 }
    );
  });
});

/** A response `_document` allowed, captured as there, then ended the way Next ends it. */
function sendThroughCapture(
  url: string,
  change: (res: FakeResponse) => void = () => undefined,
  requestHeaders: Record<string, string> = {}
) {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    end: () => undefined,
  };
  captureBotCacheRender(
    { url, headers: { host: 'civitai.com', ...requestHeaders } } as never,
    res as never,
    IMAGE_ROUTE as never
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  change(res);
  (res.end as (chunk: string) => void).call(res, HTML);
}

type FakeResponse = { statusCode: number; setHeader: (name: string, value: unknown) => void };

describe('capture stores only a response that ends as a 200 without a cookie', () => {
  it.each<[string, (res: FakeResponse) => void]>([
    [
      'a status set to 500 before the end',
      (res) => {
        res.statusCode = 500;
      },
    ],
    ['a Set-Cookie added before the end', (res) => res.setHeader('Set-Cookie', ['a=1; Path=/'])],
  ])('%s is not stored', async (_, change) => {
    sendThroughCapture('/images/1', change);
    expect(brotliCompress).not.toHaveBeenCalled();
    // INSTRUMENT CHECK: a response ended after it, through the same capture, is stored.
    sendThroughCapture('/images/2');
    expect(brotliCompress).toHaveBeenCalledTimes(1);
    const control = keyFor('civitai.com', '/images/2');
    await vi.waitFor(() => expect([...store.keys()]).toEqual([control]));
  });
});

/** The page request Next makes after the proxy: it copies the proxy's response headers onto it. */
function renderRequestHeaders(request: NextRequest, response: Response) {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.headers.forEach((value, name) => {
    if (!name.startsWith('x-middleware-')) headers[name] = value;
  });
  return headers;
}

describe('the render after a failed lookup is not stored', () => {
  it.each<[string, () => void]>([
    [
      'a redis error',
      () => redisMock.redis.packed.get.mockRejectedValue(new Error('connection reset')),
    ],
    [
      'a lookup that never answers',
      () =>
        redisMock.redis.packed.get.mockImplementation(() => new Promise<never>(() => undefined)),
    ],
  ])('%s', async (_, fail) => {
    fail();
    const request = crawler();
    const response = await serve(request);
    expectRendered(response);
    sendThroughCapture('/images/1', undefined, renderRequestHeaders(request, response));
    expect(brotliCompress).not.toHaveBeenCalled();
  });

  it('INSTRUMENT CHECK: the render after a plain miss is stored', async () => {
    // Its own URL, and its own key awaited: a store an earlier case wrongly started can land here.
    const request = crawler('https://civitai.com/images/3');
    const response = await serve(request);
    expect(response.headers.get('x-civ-bot-cache')).toBe('miss');
    sendThroughCapture('/images/3', undefined, renderRequestHeaders(request, response));
    expect(brotliCompress).toHaveBeenCalledTimes(1);
    const control = keyFor('civitai.com', '/images/3');
    await vi.waitFor(() => expect([...store.keys()]).toContain(control));
  });
});

describe('the middleware never rejects', () => {
  it('a predicate that throws renders the page as if there were no cache', async () => {
    await seed();
    h.predicateThrows = true;
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBeNull();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });
});

describe('without a real build id (the `unknown` fallback)', () => {
  it('there is no key', () => {
    h.buildId = 'unknown';
    expect(botCacheKey('civitai.com', '/images/1', '', undefined)).toBeNull();
    expect(botCacheKey('civitai.com', '/images/1', '', undefined, '')).toBeNull();
  });

  it('nothing is served, though an entry exists under the fallback id', async () => {
    await seed();
    store.set('botcache:v1:unknown:d:civitai.com:/images/1?', [...store.values()][0]);
    h.buildId = 'unknown';
    const response = await serve(crawler());
    expectRendered(response);
    expect(response.headers.get('x-civ-bot-cache')).toBeNull();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });

  it('nothing is stored', async () => {
    h.buildId = 'unknown';
    sendThroughCapture('/images/1');
    expect(brotliCompress).not.toHaveBeenCalled();
    // INSTRUMENT CHECK: with a build id, the same capture stores.
    h.buildId = 'build-a';
    sendThroughCapture('/images/2');
    expect(brotliCompress).toHaveBeenCalledTimes(1);
    const control = keyFor('civitai.com', '/images/2');
    await vi.waitFor(() => expect([...store.keys()]).toEqual([control]));
  });
});
