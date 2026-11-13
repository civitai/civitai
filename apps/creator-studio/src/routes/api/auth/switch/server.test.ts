import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

const switchAccount = vi.hoisted(() => vi.fn());

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createDeviceAccountClient: () => ({ switch: switchAccount }),
}));

const { POST } = await import('./+server');

const ORIGINAL_ENV = { ...process.env };
const SWITCH_URL = 'https://creators.civitai.com/api/auth/switch';

async function post(opts: { cookie: string; userId?: unknown; signedIn?: boolean }) {
  const request = new Request(SWITCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: opts.cookie },
    body: JSON.stringify({ userId: opts.userId ?? 2 }),
  });
  const event = {
    request,
    url: new URL(SWITCH_URL),
    locals: { user: opts.signedIn === false ? undefined : { id: 1 } },
  } as unknown as Parameters<typeof POST>[0];
  try {
    return await POST(event);
  } catch (e) {
    // SvelteKit's error() throws an HttpError; the framework turns it into a response with no Set-Cookie.
    const status = (e as { status?: number }).status;
    if (typeof status !== 'number') throw e;
    return new Response(null, { status });
  }
}

const sets = (res: Response, name: string) =>
  res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`) && !/Max-Age=0/.test(h));
const expires = (res: Response, name: string) =>
  res.headers.getSetCookie().some((h) => h.startsWith(`${name}=;`) && /Max-Age=0/.test(h));

describe('POST /api/auth/switch', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://creators.civitai.com';
    switchAccount.mockReset();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('answers 401 and never asks the hub when signed out', async () => {
    const res = await post({ cookie: '__Secure-civ-token=old', signedIn: false });
    expect(res.status).toBe(401);
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it('answers 403 with no Set-Cookie when the hub declines', async () => {
    switchAccount.mockResolvedValue(null);
    const res = await post({ cookie: '__Secure-civ-token=old; __Secure-civ-device=dev' });
    expect(switchAccount).toHaveBeenCalledWith(
      '__Secure-civ-token=old; __Secure-civ-device=dev',
      2
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('in shared mode sets the shared token and expires the host-only pair the request carried', async () => {
    switchAccount.mockResolvedValue({ token: 'new-tok' });
    const res = await post({
      cookie:
        '__Secure-civ-token=old; __Secure-civ-device=dev; __Host-civ-token=stale; __Host-civ-device=dev2',
    });
    expect(res.status).toBe(200);
    expect(sets(res, '__Secure-civ-token')).toMatch(
      /^__Secure-civ-token=new-tok;.*Domain=civitai\.com/
    );
    expect(sets(res, '__Secure-civ-device')).toMatch(/^__Secure-civ-device=dev;/);
    expect(expires(res, '__Host-civ-token')).toBe(true);
    expect(expires(res, '__Host-civ-device')).toBe(true);
    expect(sets(res, '__Host-civ-token')).toBeUndefined();
  });

  it('in host mode sets the host-only token and expires the shared pair the request carried', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    switchAccount.mockResolvedValue({ token: 'new-tok' });
    const res = await post({
      cookie:
        '__Host-civ-token=old; __Host-civ-device=dev; __Secure-civ-token=stale; __Secure-civ-device=dev2',
    });
    expect(res.status).toBe(200);
    const token = sets(res, '__Host-civ-token');
    expect(token).toMatch(/^__Host-civ-token=new-tok;/);
    expect(token).not.toMatch(/Domain=/);
    expect(sets(res, '__Host-civ-device')).toMatch(/^__Host-civ-device=dev;/);
    expect(expires(res, '__Secure-civ-token')).toBe(true);
    expect(expires(res, '__Secure-civ-device')).toBe(true);
  });
});
