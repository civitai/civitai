import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as CivCookie from '~/server/auth/civ-cookie';

// The real bridge decides the outcome, the clears and the return path; only the session read, the session
// cookie write and the hub are faked.
const h = vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://hub.test';
  return { getHubSession: vi.fn() };
});
vi.mock('~/server/auth/session-client', () => ({ getHubSession: h.getHubSession }));
vi.mock('~/server/auth/civ-cookie', async (importOriginal) => ({
  ...(await importOriginal<typeof CivCookie>()),
  setSessionCookie: vi.fn(),
  cookieDomainForHost: vi.fn(() => 'civitai.red'),
}));

import handler from '~/pages/api/auth/callback';
import authorize from '~/pages/api/auth/authorize';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const STATE = 's'.repeat(32);
// Set by a successful callback on this host, for 60s.
const JUST_SIGNED_IN = { civ_postlogin: '1' };
const stash = (r: string, s = STATE) => JSON.stringify({ v: 'verifier', s, r });

function fakeRes() {
  const out: { location?: string; setCookie: string[] } = { setCookie: [] };
  const res = {
    setHeader: vi.fn((name: string, value: string | string[]) => {
      if (name === 'Set-Cookie') out.setCookie = ([] as string[]).concat(value);
    }),
    getHeader: vi.fn((name: string) => (name === 'Set-Cookie' ? out.setCookie : undefined)),
    redirect: vi.fn((_status: number, to: string) => {
      out.location = to;
      return res;
    }),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as NextApiResponse;
  return { res, out };
}

function req(cookies: Record<string, string>, query: Record<string, string>) {
  return {
    method: 'GET',
    headers: { host: 'civitai.red' },
    query,
    cookies,
    socket: {},
  } as unknown as NextApiRequest;
}

async function call(opts: { cookies: Record<string, string>; query?: Record<string, string> }) {
  const { res, out } = fakeRes();
  await handler(req(opts.cookies, opts.query ?? { code: 'c', state: STATE }), res);
  return out;
}

const lastLog = () =>
  (loggingMock.logToAxiom.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

/** The hub's half of PKCE: a code redeems only with the verifier whose challenge it was issued for. */
function pkceHub() {
  const challengeByCode = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const { code, code_verifier } = JSON.parse(String(init?.body));
      const challenge = createHash('sha256').update(String(code_verifier)).digest('base64url');
      return challengeByCode.get(code) === challenge
        ? Response.json({ token: `token-${code}` })
        : new Response(null, { status: 400 });
    })
  );
  return (location: string) => {
    const params = new URL(location).searchParams;
    const code = `code-${params.get('state')}`;
    challengeByCode.set(code, params.get('code_challenge')!);
    return { code, state: params.get('state')! };
  };
}

/** A browser jar for civitai.red: applies Set-Cookie by name, Max-Age=0 deletes. */
function jar() {
  const cookies: Record<string, string> = {};
  return {
    cookies,
    apply(setCookie: string[]) {
      for (const c of setCookie) {
        const [pair] = c.split(';');
        const name = pair.slice(0, pair.indexOf('='));
        if (/Max-Age=0(;|$)/.test(c)) delete cookies[name];
        else cookies[name] = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
      }
    },
  };
}

beforeEach(() => {
  h.getHubSession.mockReset();
  loggingMock.logToAxiom.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 400 }))
  );
});

describe('callback: parallel sign-in tabs', () => {
  it('two tabs started before either returns both sign in, each clearing only its own stash', async () => {
    const hub = pkceHub();
    const browser = jar();
    const tabs = ['/a', '/b'].map((page) => {
      const { res, out } = fakeRes();
      authorize(req(browser.cookies, { returnUrl: page }), res);
      browser.apply(out.setCookie);
      return { page, ...hub(out.location!) };
    });

    for (const tab of tabs) {
      const out = await call({
        cookies: { ...browser.cookies },
        query: { code: tab.code, state: tab.state },
      });
      expect(out.location).toBe(tab.page);
      const clears = out.setCookie.filter(
        (c) => c.startsWith('oauth_bridge') && /Max-Age=0/.test(c)
      );
      expect(clears.some((c) => c.startsWith(`oauth_bridge_${tab.state}=`))).toBe(true);
      expect(clears.every((c) => c.includes('Domain=civitai.red'))).toBe(true);
      const otherTab = tabs.find((t) => t !== tab)!;
      expect(clears.some((c) => c.startsWith(`oauth_bridge_${otherTab.state}=`))).toBe(false);
      browser.apply(out.setCookie);
    }
    expect(Object.keys(browser.cookies).filter((k) => k.startsWith('oauth_bridge'))).toEqual([]);
  });

  it('a failed callback still clears its own stash', async () => {
    const out = await call({ cookies: { [`oauth_bridge_${STATE}`]: stash('/models/7') } });
    expect(out.location).toBe('/login?error=oauth_exchange');
    expect(
      out.setCookie.some((c) => c.startsWith(`oauth_bridge_${STATE}=;`) && /Max-Age=0/.test(c))
    ).toBe(true);
  });
});

describe('callback: a failed state check right after this host signed in', () => {
  it('a duplicate callback (its stash already used) continues to / instead of the sign-in error', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    // Another tab's stash is still in flight; this flow's own was consumed by the first callback.
    const other = 'o'.repeat(32);
    const out = await call({
      cookies: { ...JUST_SIGNED_IN, [`oauth_bridge_${other}`]: stash('/b', other) },
    });
    expect(out.location).toBe('/');
    expect(lastLog()).toMatchObject({
      outcome: 'exchange-error',
      detail: 'state_mismatch',
      signedIn: true,
    });
  });

  it('a hub return without a code, with this flow’s stash present, continues to the stashed page', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const out = await call({
      cookies: { ...JUST_SIGNED_IN, [`oauth_bridge_${STATE}`]: stash('/models/7') },
      query: { state: STATE },
    });
    expect(out.location).toBe('/models/7');
  });

  it.each([
    ['absolute offsite', 'https://evil.example/x'],
    ['protocol-relative', '//evil.example/x'],
  ])('a stashed %s return path lands on /', async (_name, r) => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const out = await call({
      cookies: { ...JUST_SIGNED_IN, [`oauth_bridge_${STATE}`]: stash(r) },
      query: { state: STATE },
    });
    expect(out.location).toBe('/');
  });

  it('signed in but no sign-in just completed here (a failed add-account or sync) shows the error', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const out = await call({ cookies: {} });
    expect(out.location).toBe('/login?error=oauth_state');
  });

  it('a hub-sent error is never covered', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const out = await call({ cookies: { ...JUST_SIGNED_IN }, query: { error: 'oauth_state' } });
    expect(out.location).toBe('/login?error=oauth_state');
  });

  it('without a session it still shows the sign-in error', async () => {
    h.getHubSession.mockResolvedValue(null);
    const out = await call({ cookies: { ...JUST_SIGNED_IN } });
    expect(out.location).toBe('/login?error=oauth_state');
    expect(lastLog()).not.toHaveProperty('signedIn');
  });

  it('a session read that fails shows the sign-in error', async () => {
    h.getHubSession.mockRejectedValue(new Error('hub down'));
    const out = await call({ cookies: { ...JUST_SIGNED_IN } });
    expect(out.location).toBe('/login?error=oauth_state');
  });

  it('a rejected code exchange is not covered: it shows the error even when signed in', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const out = await call({
      cookies: { ...JUST_SIGNED_IN, [`oauth_bridge_${STATE}`]: stash('/models/7') },
    });
    expect(out.location).toBe('/login?error=oauth_exchange');
    expect(h.getHubSession).not.toHaveBeenCalled();
  });
});
