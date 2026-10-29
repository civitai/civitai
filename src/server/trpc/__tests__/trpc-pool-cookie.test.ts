/**
 * The tRPC routing cookie (`~/server/trpc/trpc-pool-cookie`): exact host-only attributes when set,
 * an exact clear, and one entry per response.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it } from 'vitest';
import {
  syncTrpcPoolCookie,
  TRPC_POOL_COOKIE,
  TRPC_POOL_COOKIE_MAX_AGE_S,
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

const SET = 'civ-trpc-pool=1; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax';
const CLEAR = 'civ-trpc-pool=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax';

describe('syncTrpcPoolCookie', () => {
  it('names the cookie the edge matches on, with a seven-day lifetime', () => {
    expect(TRPC_POOL_COOKIE).toBe('civ-trpc-pool');
    expect(TRPC_POOL_COOKIE_MAX_AGE_S).toBe(7 * 24 * 60 * 60);
  });

  it('flag on, no cookie: sets it with the exact attributes', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq(), res, true);
    expect(setCookies()).toEqual([SET]);
  });

  it.each(['civitai.com', 'civitai.red', 'www.civitai.red:443', 'localhost:3000'])(
    'is host-only on %s: no Domain attribute, set or clear',
    (host) => {
      const on = makeRes();
      syncTrpcPoolCookie(makeReq({ host }), on.res, true);
      expect(on.setCookies()).toEqual([SET]);

      const off = makeRes();
      syncTrpcPoolCookie(makeReq({ host, cookie: 'civ-trpc-pool=1' }), off.res, false);
      expect(off.setCookies()).toEqual([CLEAR]);

      expect([...on.setCookies(), ...off.setCookies()].join(';').toLowerCase()).not.toContain(
        'domain='
      );
    }
  );

  it('flag on, cookie already present: writes nothing', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1' }), res, true);
    expect(setCookies()).toEqual([]);
  });

  it('flag on, cookie present with another value: re-sets it', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=0' }), res, true);
    expect(setCookies()).toEqual([SET]);
  });

  it('flag off, cookie present: clears it', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1; other=x' }), res, false);
    expect(setCookies()).toEqual([CLEAR]);
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
    expect(setCookies()).toEqual(['ref=1; Path=/', SET]);
  });
});
