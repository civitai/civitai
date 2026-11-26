import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  BOT_CACHE_PREFETCH_FAILED_REQ_KEY as FAILED,
  BOT_CACHE_REQ_KEY as ROUTE_MARK,
} from '~/shared/constants/bot-cache.constants';

/**
 * `botCacheRefusal`: which requests may get a cacheable render. Every case starts from one
 * request that gets it and changes ONE fact, so each refusal is reached on its own and must answer
 * with its own reason — a guard that is never reached cannot pass on an earlier one's verdict. The
 * kill switch is the real Flipt gate over a stub that answers per key, so a wrong key reads as off.
 */

const flipt = vi.hoisted(() => {
  // `serverDomainMap` is built from these at module load. Prod shape: .red is blue AND red.
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_GREEN_ALIASES = 'www.civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.red';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitaired.com';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  process.env.SERVER_DOMAIN_RED_ALIASES = '';
  return { on: new Set<string>(), calls: [] as unknown[][] };
});

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => ({})),
  isFliptSync: vi.fn((key: string, ...rest: unknown[]) => {
    flipt.calls.push([key, ...rest]);
    return flipt.on.has(key) ? true : null;
  }),
}));

import {
  applyBotCachePrivateHeaders,
  botCacheRefusal,
  botCacheResponseRefusal,
  botCacheSeed,
  resetBotCacheFlagGateForTests,
  resolveBotCacheRoute,
} from '~/server/bot-cache/bot-cache';

const SECRET = 'bot-cache-unit-secret-7f3a';
const MODEL_ROUTE = '/models/[id]/[[...slug]]';

type Req = { method: string; url: string; headers: Record<string, string> };

function eligible(over: Partial<Req> = {}, headers: Record<string, string> = {}): Req {
  return {
    method: 'GET',
    url: '/models/4201/some-model',
    ...over,
    headers: {
      host: 'civitai.com',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'cf-ipcountry': 'US',
      'x-civ-cf-verified-bot': SECRET,
      ...headers,
    },
  };
}

const without = (req: Req, header: string): Req => {
  const headers = { ...req.headers };
  delete headers[header];
  return { ...req, headers };
};

const refusal = (req: Req, pathname = MODEL_ROUTE, degraded = false) =>
  botCacheRefusal(req as never, pathname, { degraded });

beforeEach(() => {
  resetEnv();
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
  flipt.on = new Set(['bot-html-edge-cache']);
  flipt.calls = [];
  resetBotCacheFlagGateForTests();
});

describe('botCacheRefusal', () => {
  it('allows a verified crawler on civitai.com when every condition holds', () => {
    expect(refusal(eligible())).toBeNull();
    expect(resolveBotCacheRoute(eligible() as never, MODEL_ROUTE, { degraded: false })).toBe(
      'models'
    );
  });

  // A few representatives; that every allowlisted route is a createServerSideProps page is
  // `bot-cache-routes-pages.test.ts`.
  it.each([
    ['/models/[id]/[[...slug]]', 'models'],
    ['/images/[imageId]', 'images'],
    ['/posts/[postId]/[[...postSlug]]', 'posts'],
    ['/articles/[id]/[[...slug]]', 'articles'],
    ['/user/[username]', 'user'],
    ['/user/[username]/[list]', 'user'],
    ['/user/[username]/models', 'user'],
  ])('allows the route %s as %s', (pathname, name) => {
    expect(resolveBotCacheRoute(eligible() as never, pathname, { degraded: false })).toBe(name);
  });

  it('allows a green alias', () => {
    expect(refusal(eligible({}, { host: 'www.civitai.com' }))).toBeNull();
  });

  it.each<[string, Req, string?, boolean?]>([
    ['method', eligible({ method: 'HEAD' })],
    ['method', eligible({ method: 'POST' })],
    ['route', eligible(), '/user/[username]/manage-categories'],
    ['route', eligible(), '/user/[username]/shop/manage'],
    ['route', eligible(), '/user/[username]/[[...slug]]'],
    ['route', eligible(), '/models/[id]/reviews'],
    ['route', eligible(), '/_error'],
    ['route', eligible(), '/404'],
    ['data-request', eligible({ url: '/_next/data/build/models/4201.json' })],
    ['data-request', eligible({}, { 'x-nextjs-data': '1' })],
    ['host', eligible({}, { host: 'civitai.red' })],
    ['host', eligible({}, { host: 'civitaired.com' })],
    ['host', eligible({}, { host: 'elsewhere.example' })],
    ['host', without(eligible(), 'host')],
    ['authorization', eligible({}, { authorization: 'Bearer key' })],
    ['authorization', eligible({}, { authorization: '' })],
    ['query-token', eligible({ url: '/models/4201?token=abc' })],
    ['query-token', eligible({ url: '/models/4201?modelVersionId=1&token=' })],
    ['cookie', eligible({}, { cookie: '__Secure-civ-token=a.b.c' })],
    ['cookie', eligible({}, { cookie: 'mantine-color-scheme=light' })],
    ['cookie', eligible({}, { cookie: 'civitai-consent=accepted' })],
    ['region', eligible({}, { 'cf-ipcountry': 'GB' })],
    ['region', eligible({}, { 'x-isuk': '1' })],
    ['no-bot-header', without(eligible(), 'x-civ-cf-verified-bot')],
    ['no-bot-header', eligible({}, { 'x-civ-cf-verified-bot': '' })],
    ['bot-header-mismatch', eligible({}, { 'x-civ-cf-verified-bot': 'guess' })],
    ['bot-header-mismatch', eligible({}, { 'x-civ-cf-verified-bot': `${SECRET}x` })],
    ['bot-header-mismatch', eligible({}, { 'x-civ-cf-verified-bot': '1' })],
    // The origin's own IP-verified header is not the edge's.
    [
      'no-bot-header',
      without(eligible({}, { 'x-civitai-verified-bot': 'googlebot' }), 'x-civ-cf-verified-bot'),
    ],
    ['degraded', eligible(), MODEL_ROUTE, true],
  ])('refuses with %s', (reason, req, pathname, degraded) => {
    expect(refusal(req, pathname ?? MODEL_ROUTE, degraded ?? false)).toBe(reason);
    expect(
      resolveBotCacheRoute(req as never, pathname ?? MODEL_ROUTE, { degraded: degraded ?? false })
    ).toBeNull();
  });

  it('refuses with no-secret when the secret is unset or empty, whatever the header says', () => {
    for (const secret of [undefined, '']) {
      setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: secret });
      expect(refusal(eligible()), String(secret)).toBe('no-secret');
      expect(refusal(eligible({}, { 'x-civ-cf-verified-bot': '' })), String(secret)).toBe(
        'no-bot-header'
      );
    }
  });

  it('refuses with kill-switch while bot-html-edge-cache is off, or Flipt has no answer', () => {
    flipt.on = new Set(['shell-master']);
    expect(refusal(eligible())).toBe('kill-switch');
  });

  it('reads the switch globally: no user, no entity, no context', () => {
    refusal(eligible());
    expect(flipt.calls).toEqual([['bot-html-edge-cache']]);
  });

  it('reads the switch only once every request fact has passed', () => {
    refusal(eligible({}, { cookie: 'a=1' }));
    refusal(eligible(), MODEL_ROUTE, true);
    expect(flipt.calls).toEqual([]);
  });
});

describe('botCacheSeed', () => {
  it('is the same for one URL and differs between URLs', () => {
    expect(botCacheSeed('/models/4201/a')).toBe(botCacheSeed('/models/4201/a'));
    expect(botCacheSeed('/models/4201/a')).not.toBe(botCacheSeed('/models/4202/a'));
    expect(botCacheSeed('/models/4201/a')).not.toBe(
      botCacheSeed('/models/4201/a?modelVersionId=9')
    );
    expect(Number.isInteger(botCacheSeed(undefined))).toBe(true);
  });
});

function fakeResponse(statusCode = 200, initial: Record<string, unknown> = {}) {
  const headers = new Map<string, unknown>(
    Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    statusCode,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
  };
}

describe('botCacheResponseRefusal', () => {
  const marked = (marks: Record<string, unknown>) => ({ headers: {}, ...marks });

  it('allows a 200 render of the route _app marked', () => {
    const req = marked({ [ROUTE_MARK]: 'models' });
    expect(botCacheResponseRefusal(req as never, fakeResponse() as never, MODEL_ROUTE)).toBeNull();
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    ['not-eligible', {}, 200, MODEL_ROUTE],
    // `notFound` / a throw re-render the same request as `/404` / `/_error`.
    ['not-eligible', { [ROUTE_MARK]: 'models' }, 404, '/404'],
    ['not-eligible', { [ROUTE_MARK]: 'models' }, 500, '/_error'],
    ['not-eligible', { [ROUTE_MARK]: 'images' }, 200, MODEL_ROUTE],
    ['prefetch-failed', { [ROUTE_MARK]: 'models', [FAILED]: true }, 200, MODEL_ROUTE],
    ['status', { [ROUTE_MARK]: 'models' }, 500, MODEL_ROUTE],
  ])('refuses with %s', (reason, marks, status, pathname) => {
    expect(
      botCacheResponseRefusal(marked(marks) as never, fakeResponse(status) as never, pathname)
    ).toBe(reason);
  });
});

describe('applyBotCachePrivateHeaders', () => {
  it('private to browsers, drops any cookie, and adds no edge-cache directive', () => {
    const res = fakeResponse(200, {
      'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
      'Set-Cookie': ['a=1; Path=/'],
    });
    applyBotCachePrivateHeaders(res as never);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
    expect(res.getHeader('Cloudflare-CDN-Cache-Control')).toBeUndefined();
    expect(res.getHeader('Cache-Tag')).toBeUndefined();
  });
});
