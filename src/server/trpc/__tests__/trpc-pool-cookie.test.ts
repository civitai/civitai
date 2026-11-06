/**
 * The tRPC routing cookie (`~/server/trpc/trpc-pool-cookie`): exact host-only attributes when set,
 * an exact clear, one entry per response, and nothing on a response a shared cache may store.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it } from 'vitest';
import { syncTrpcPoolCookie, TRPC_POOL_COOKIE } from '~/server/trpc/trpc-pool-cookie';

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
  it('names the cookie the edge matches on', () => {
    expect(TRPC_POOL_COOKIE).toBe('civ-trpc-pool');
  });

  it('flag on, no cookie: sets it with the exact attributes', () => {
    const { res, setCookies } = makeRes();
    syncTrpcPoolCookie(makeReq(), res, true);
    expect(setCookies()).toEqual([SET]);
  });

  it('is host-only: no Domain attribute, set or clear', () => {
    const host = 'www.civitai.red:443';
    const on = makeRes();
    syncTrpcPoolCookie(makeReq({ host }), on.res, true);
    expect(on.setCookies()).toEqual([SET]);

    const off = makeRes();
    syncTrpcPoolCookie(makeReq({ host, cookie: 'civ-trpc-pool=1' }), off.res, false);
    expect(off.setCookies()).toEqual([CLEAR]);

    expect([...on.setCookies(), ...off.setCookies()].join(';').toLowerCase()).not.toContain(
      'domain='
    );
  });

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

  it.each([
    'public, max-age=86400, must-revalidate',
    'max-age=0, s-maxage=60',
    'S-MAXAGE=60',
    ['no-transform', 'public'],
  ])('a response a shared cache may store (Cache-Control: %s): never set, never cleared', (cc) => {
    const on = makeRes({ 'Cache-Control': cc });
    syncTrpcPoolCookie(makeReq(), on.res, true);
    expect(on.setCookies()).toEqual([]);

    const off = makeRes({ 'Cache-Control': cc });
    syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1' }), off.res, false);
    expect(off.setCookies()).toEqual([]);
  });

  it.each(['private, no-cache, no-store, max-age=0, must-revalidate', 'max-age=60', 'no-cache'])(
    'a private or non-shared Cache-Control (%s): still set and cleared',
    (cc) => {
      const on = makeRes({ 'Cache-Control': cc });
      syncTrpcPoolCookie(makeReq(), on.res, true);
      expect(on.setCookies()).toEqual([SET]);

      const off = makeRes({ 'Cache-Control': cc });
      syncTrpcPoolCookie(makeReq({ cookie: 'civ-trpc-pool=1' }), off.res, false);
      expect(off.setCookies()).toEqual([CLEAR]);
    }
  );
});
