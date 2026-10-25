import { describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * `shellRefusal`: which requests get the static shell. Every case starts from one request that
 * gets it and changes ONE fact, so each refusal is reached on its own — no earlier check can be the
 * one that answers. The kill switch is the real `shellMaster` registry entry over a Flipt stub that
 * answers per key, so a wrong key or a per-user evaluation turns it red.
 */

const flipt = vi.hoisted(() => ({
  on: new Set<string>(),
  entities: [] as string[],
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  isFliptSync: vi.fn((key: string, entity: string) => {
    if (key === 'shell-master') flipt.entities.push(entity);
    return flipt.on.has(key) ? true : null;
  }),
}));

import { isCanonicalShellRequest, resolveShellMode, shellRefusal } from '~/server/shell/shell-mode';

const ROUTE = '/images/[imageId]';

type Req = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

// Each flag evaluation is memoised per (user, host) for 10 s, so every case that reaches the kill
// switch gets its own host.
let hostSeq = 0;
function eligible(over: Partial<Req> = {}, headers: Record<string, string> = {}): Req {
  return {
    method: 'GET',
    url: '/images/123?postId=5',
    ...over,
    headers: {
      host: `shell-mode-${++hostSeq}.test`,
      cookie: '__Secure-civ-token=a.b.c; civ-shell-images=1',
      'cf-ipcountry': 'US',
      ...headers,
    },
  };
}

const refusal = (req: Req, pathname = ROUTE) => shellRefusal(req as never, pathname);

describe('shellRefusal', () => {
  it('serves the shell to a signed-in browser request with the route cookie and the switch on', async () => {
    flipt.on = new Set(['shell-master']);
    expect(await refusal(eligible())).toBeNull();
    expect(await resolveShellMode(eligible() as never, ROUTE)).toBe('images');
  });

  it('accepts the legacy session cookie family too', async () => {
    flipt.on = new Set(['shell-master']);
    const req = eligible({}, { cookie: '__Secure-civitai-token=legacy; civ-shell-images=1' });
    expect(await refusal(req)).toBeNull();
  });

  it('reads the kill switch with no user: one switch for everyone', async () => {
    flipt.on = new Set(['shell-master']);
    flipt.entities = [];
    await refusal(eligible());
    expect(flipt.entities).toEqual(['anonymous']);
  });

  it.each<[string, Req, string?]>([
    ['method', eligible({ method: 'HEAD' })],
    ['route', eligible(), '/models/[id]/[[...slug]]'],
    ['data-request', eligible({ url: '/_next/data/build/images/123.json' })],
    ['data-request', eligible({}, { 'x-nextjs-data': '1' })],
    ['bypass', eligible({ url: '/images/123?postId=5&civ-shell=0' })],
    ['verified-bot', eligible({}, { 'x-civitai-verified-bot': 'googlebot' })],
    ['authorization', eligible({}, { authorization: 'Bearer key' })],
    ['query-token', eligible({ url: '/images/123?token=abc' })],
    ['no-session-cookie', eligible({}, { cookie: 'civ-shell-images=1' })],
    ['no-session-cookie', eligible({}, { cookie: '' })],
    ['no-route-cookie', eligible({}, { cookie: '__Secure-civ-token=a.b.c' })],
    ['no-route-cookie', eligible({}, { cookie: '__Secure-civ-token=a.b.c; civ-shell-images=0' })],
    ['region', eligible({}, { 'cf-ipcountry': 'GB' })],
    ['region', eligible({}, { 'x-isuk': '1' })],
    // A path the moderator guard owns, reached through the route (a rewrite).
    ['auth-guard', eligible({ url: '/moderator/images/123' })],
  ])('refuses with %s', async (reason, req, pathname) => {
    flipt.on = new Set(['shell-master']);
    expect(await refusal(req, pathname)).toBe(reason);
    expect(await resolveShellMode(req as never, pathname ?? ROUTE)).toBeNull();
  });

  it('refuses with kill-switch while shell-master is off or Flipt has no answer', async () => {
    flipt.on = new Set(['shell-images']);
    expect(await refusal(eligible())).toBe('kill-switch');
  });

  it('a civ-shell value other than 0 is not the bypass', async () => {
    flipt.on = new Set(['shell-master']);
    expect(await refusal(eligible({ url: '/images/123?civ-shell=1' }))).toBeNull();
  });
});

/**
 * The canonical path (`~/server/shell/shell-canonical`): the edge rewrites every eligible
 * `/images/<id>` there and passes the original URL in a header. The same refusals hold, judged on
 * the ORIGINAL URL as well as the canonical one, and a missing or invalid original refuses.
 */
describe('shellRefusal on the canonical path', () => {
  const canonical = (orig: string | undefined, headers: Record<string, string> = {}) =>
    eligible(
      { url: '/images/shell' },
      { ...(orig === undefined ? {} : { 'x-civ-shell-orig': orig }), ...headers }
    );

  it('serves the shell for a valid original URL', async () => {
    flipt.on = new Set(['shell-master']);
    expect(await refusal(canonical('/images/123?postId=5'))).toBeNull();
    expect(await resolveShellMode(canonical('/images/123') as never, ROUTE)).toBe('images');
  });

  it.each<[string, Req]>([
    ['original-url', canonical(undefined)],
    ['original-url', canonical('')],
    ['original-url', canonical('https://evil.example/images/1')],
    ['original-url', canonical('//evil.example/images/1')],
    ['original-url', canonical('/models/1')],
    ['original-url', canonical('/images/shell')],
    ['method', { ...canonical('/images/123'), method: 'HEAD' }],
    ['data-request', canonical('/images/123', { 'x-nextjs-data': '1' })],
    // Judged on the original URL: the canonical URL itself carries no query.
    ['bypass', canonical('/images/123?postId=5&civ-shell=0')],
    ['query-token', canonical('/images/123?token=abc')],
    ['verified-bot', canonical('/images/123', { 'x-civitai-verified-bot': 'googlebot' })],
    ['authorization', canonical('/images/123', { authorization: 'Bearer key' })],
    ['no-session-cookie', canonical('/images/123', { cookie: 'civ-shell-images=1' })],
    ['no-route-cookie', canonical('/images/123', { cookie: '__Secure-civ-token=a.b.c' })],
    ['region', canonical('/images/123', { 'cf-ipcountry': 'GB' })],
  ])('refuses with %s', async (reason, req) => {
    flipt.on = new Set(['shell-master']);
    expect(await refusal(req)).toBe(reason);
    expect(await resolveShellMode(req as never, ROUTE)).toBeNull();
  });

  it('refuses with kill-switch while shell-master is off', async () => {
    flipt.on = new Set(['shell-images']);
    expect(await refusal(canonical('/images/123'))).toBe('kill-switch');
  });

  it('a real image URL ignores the header entirely', async () => {
    flipt.on = new Set(['shell-master']);
    const req = eligible({}, { 'x-civ-shell-orig': '/images/1?civ-shell=0&token=abc' });
    expect(await refusal(req)).toBeNull();
  });
});

describe('isCanonicalShellRequest', () => {
  it.each<[string, string, boolean]>([
    ['/images/shell', ROUTE, true],
    ['/images/shell?postId=5', ROUTE, true],
    ['/images/123', ROUTE, false],
    // `/_error` re-runs `_app` on the same request: it must render, not wait for a bounce.
    ['/images/shell', '/_error', false],
  ])('%s as %s → %s', (url, pathname, expected) => {
    expect(isCanonicalShellRequest(eligible({ url }) as never, pathname)).toBe(expected);
  });
});
