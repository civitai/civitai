import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// The real bridge decides the outcome and the return path; only the session read and the hub are faked.
const h = vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://hub.test';
  return { getHubSession: vi.fn() };
});
vi.mock('~/server/auth/session-client', () => ({ getHubSession: h.getHubSession }));
vi.mock('~/server/auth/civ-cookie', () => ({
  setSessionCookie: vi.fn(),
  postLoginMarkerCookie: vi.fn(() => 'civ-post-login=1'),
  clearLegacyCookies: vi.fn(() => []),
  hasAnyLegacyCookie: vi.fn(() => false),
  cookieDomainForHost: vi.fn(() => undefined),
}));

import handler from '~/pages/api/auth/callback';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const STATE = 's'.repeat(32);
const stash = (r: string, s = STATE) => JSON.stringify({ v: 'verifier', s, r });

function call(opts: { cookies: Record<string, string>; query?: Record<string, string> }) {
  const req = {
    method: 'GET',
    headers: { host: 'civitai.red' },
    query: opts.query ?? { code: 'c', state: STATE },
    cookies: opts.cookies,
    socket: {},
  } as unknown as NextApiRequest;
  let location: string | undefined;
  const res = {
    setHeader: vi.fn(),
    getHeader: vi.fn(() => undefined),
    redirect: vi.fn((_status: number, to: string) => {
      location = to;
      return res;
    }),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as NextApiResponse;
  return handler(req, res).then(() => location);
}

const lastLog = () =>
  (loggingMock.logToAxiom.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

beforeEach(() => {
  h.getHubSession.mockReset();
  loggingMock.logToAxiom.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 400 }))
  );
});

describe('callback: a failed state check for a browser already signed in here', () => {
  it('continues to the flow’s own page instead of the sign-in error', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    // The duplicate callback: this flow's stash was consumed by the first one; another tab's is in flight.
    const to = await call({
      cookies: { [`oauth_bridge_${'o'.repeat(32)}`]: stash('/b', 'o'.repeat(32)) },
    });
    expect(to).toBe('/');
    expect(lastLog()).toMatchObject({
      outcome: 'exchange-error',
      detail: 'state_mismatch',
      signedIn: true,
    });
  });

  it('returns to the stashed page when the stash for this state is there', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const to = await call({
      cookies: { [`oauth_bridge_${STATE}`]: stash('/models/7') },
      query: { state: STATE }, // no code: the state check fails before any exchange
    });
    expect(to).toBe('/models/7');
  });

  it.each([
    ['absolute offsite', 'https://evil.example/x'],
    ['protocol-relative', '//evil.example/x'],
  ])('a stashed %s return path lands on /', async (_name, r) => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const to = await call({
      cookies: { [`oauth_bridge_${STATE}`]: stash(r) },
      query: { state: STATE },
    });
    expect(to).toBe('/');
  });

  it('without a session it still shows the sign-in error', async () => {
    h.getHubSession.mockResolvedValue(null);
    const to = await call({ cookies: {} });
    expect(to).toBe('/login?error=oauth_state');
    expect(lastLog()).not.toHaveProperty('signedIn');
  });

  it('a rejected code exchange is not covered: it shows the error even when signed in', async () => {
    h.getHubSession.mockResolvedValue({ user: { id: 1 } });
    const to = await call({ cookies: { [`oauth_bridge_${STATE}`]: stash('/models/7') } });
    expect(to).toBe('/login?error=oauth_exchange');
    expect(h.getHubSession).not.toHaveBeenCalled();
  });
});
