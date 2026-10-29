/**
 * The tRPC routing cookie (`~/server/trpc/trpc-pool-cookie`): exact attributes when set, an exact
 * clear, nothing on a response a shared cache may store, and one entry per response.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it } from 'vitest';
import {
  isSharedCacheableResponse,
  syncTrpcPoolCookie,
  TRPC_POOL_COOKIE,
} from '~/server/trpc/trpc-pool-cookie';

function makeReq({ host = 'civitai.com', cookie }: { host?: string; cookie?: string } = {}) {
  return { headers: { host, ...(cookie ? { cookie } : {}) } } as unknown as IncomingMessage;
}

function makeRes(preset: Record<string, unknown> = {}) {
  const headers = new Map<string, unknown>(
    Object.entries(preset).map(([name, value]) => [name.toLowerCase(), value])
  );
  const res = {
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as ServerResponse;
  const setCookies = () => ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
  return { res, setCookies };
}

const SET_COM =
  'civ-trpc-pool=1; Path=/; Domain=civitai.com; Max-Age=604800; Secure; HttpOnly; SameSite=Lax';
const CLEAR_COM =
  'civ-trpc-pool=; Path=/; Domain=civitai.com; Max-Age=0; Secure; HttpOnly; SameSite=Lax';

describe('syncTrpcPoolCookie', () => {
  it('names the cookie the edge matches on', () => {
    expect(TRPC_POOL_COOKIE).toBe('civ-trpc-pool');
  });

  it('flag on, no cookie: sets it with the exact attributes', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq(), res, true);
    expect(setCookies()).toEqual([SET_COM]);
  });

  it('takes the session cookie Domain from the request host: .red, a subdomain, localhost', () => {
    const red = makeRes();
    syncTrpcPoolCookie(makeReq({ host: 'civitai.red' }), red.res, true);
    expect(red.setCookies()).toEqual([SET_COM.replace('Domain=civitai.com', 'Domain=civitai.red')]);

    const sub = makeRes();
    syncTrpcPoolCookie(makeReq({ host: 'www.civitai.red:443' }), sub.res, true);
    expect(sub.setCookies()).toEqual([SET_COM.replace('Domain=civitai.com', 'Domain=civitai.red')]);

    const local = makeRes();
    syncTrpcPoolCookie(makeReq({ host: 'localhost:3000' }), local.res, true);
    expect(local.setCookies()).toEqual([SET_COM.replace(' Domain=civitai.com;', '')]);
  });

  it('flag on, cookie already present: writes nothing', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1' }), res, true);
    expect(setCookies()).toEqual([]);
  });

  it('flag on, cookie present with another value: re-sets it', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=0' }), res, true);
    expect(setCookies()).toEqual([SET_COM]);
  });

  it('flag off, cookie present: clears it over the same Domain', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1; other=x' }), res, false);
    expect(setCookies()).toEqual([CLEAR_COM]);
  });

  it('flag off, no cookie: writes nothing', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'other=x' }), res, false);
    expect(setCookies()).toEqual([]);
  });

  it('keeps every other Set-Cookie and writes one entry for its own name across two runs', () => {
    const { res, setCookies } = makeRes({ 'Set-Cookie': ['ref=1; Path=/'] });
    syncTrpcPoolCookie(makeReq(), res, true);
    syncTrpcPoolCookie(makeReq(), res, true);
    expect(setCookies()).toEqual(['ref=1; Path=/', SET_COM]);
  });

  it.each([
    ['Cache-Control: public', { 'Cache-Control': 'public, max-age=60' }],
    ['Cache-Control: s-maxage', { 'Cache-Control': 'max-age=0, s-maxage=60' }],
    ['the edge cache header', { 'Cloudflare-CDN-Cache-Control': 'public, max-age=60' }],
    ['a purge tag', { 'Cache-Tag': 'shell' }],
  ])('a cacheable response (%s): never set, never cleared', (_, preset) => {
    const on = makeRes(preset);
    syncTrpcPoolCookie(makeReq(), on.res, true);
    expect(on.setCookies()).toEqual([]);

    const off = makeRes(preset);
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1' }), off.res, false);
    expect(off.setCookies()).toEqual([]);
  });
});

describe('isSharedCacheableResponse', () => {
  it.each([
    [{}, false],
    [{ 'Cache-Control': 'private, no-store' }, false],
    [{ 'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate' }, false],
    [{ 'Cache-Control': 'public' }, true],
    [{ 'Cache-Control': ['no-cache', 'public'] }, true],
    [{ 'Cache-Control': 's-maxage=1' }, true],
    [{ 'X-Civ-Render': 'shell' }, true],
  ])('%j -> %s', (preset, expected) => {
    expect(isSharedCacheableResponse(makeRes(preset).res)).toBe(expected);
  });
});
