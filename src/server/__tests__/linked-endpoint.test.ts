import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Handler test lives OUTSIDE src/pages (Next would treat it as a route) and imports via the ~/pages alias.
// /api/auth/linked runs the main app's post-link side effects and forwards on. It is a plain GET, so the side
// effect is gated on the one-shot cookie /api/auth/connect sets — otherwise any page could fire it in a
// logged-in visitor's browser and spend our Discord rate limit.

const { mockSync, mockSession, mockLog } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockSession: vi.fn(),
  mockLog: vi.fn(),
}));

vi.mock('~/server/jobs/apply-discord-roles', () => ({ syncUserDiscordLeaderboardRoles: mockSync }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: mockSession }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLog }));

import handler from '~/pages/api/auth/linked';

function mockReqRes(query: Record<string, string>, cookies: Record<string, string> = {}) {
  const res = {
    statusCode: 200 as number,
    location: undefined as string | undefined,
    headers: {} as Record<string, unknown>,
    getHeader(name: string) {
      return this.headers[name];
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    redirect(code: number, loc: string) {
      this.statusCode = code;
      this.location = loc;
      return this;
    },
  };
  const req = { query, cookies, headers: { host: 'civitai.com' } } as unknown as NextApiRequest;
  return { req, res };
}

const linkStarted = { 'civ-link-sync': 'nonce' };

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockResolvedValue({ user: { id: 42 } });
  mockSync.mockResolvedValue(undefined);
});

describe('/api/auth/linked', () => {
  it('syncs and forwards to the caller path when the link started here', async () => {
    const { req, res } = mockReqRes(
      { provider: 'discord', returnUrl: '/user/account#accounts' },
      linkStarted
    );
    await handler(req, res as unknown as NextApiResponse);

    expect(mockSync).toHaveBeenCalledWith(42);
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe('/user/account#accounts');
  });

  it('forwards without syncing when no link was started in this browser', async () => {
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/user/account' });
    await handler(req, res as unknown as NextApiResponse);

    expect(mockSync).not.toHaveBeenCalled();
    expect(res.location).toBe('/user/account');
  });

  it('consumes the cookie, so a replay of the same URL does not sync again', async () => {
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/' }, linkStarted);
    await handler(req, res as unknown as NextApiResponse);

    const cookies = res.getHeader('Set-Cookie') as string[];
    expect(cookies.some((c) => c.startsWith('civ-link-sync=;') && c.includes('Max-Age=0'))).toBe(
      true
    );
  });

  it('carries the hub error through and skips the sync', async () => {
    const { req, res } = mockReqRes(
      { provider: 'discord', returnUrl: '/user/account#accounts', error: 'AccountNotLinked' },
      linkStarted
    );
    await handler(req, res as unknown as NextApiResponse);

    expect(mockSync).not.toHaveBeenCalled();
    expect(res.location).toBe('/user/account?error=AccountNotLinked#accounts');
  });

  it('collapses an unsafe returnUrl instead of redirecting off-site', async () => {
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: 'https://evil.com' });
    await handler(req, res as unknown as NextApiResponse);

    expect(res.location).toBe('/');
  });

  it('still redirects when the sync hangs', async () => {
    vi.useFakeTimers();
    mockSync.mockReturnValue(new Promise(() => undefined));
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/' }, linkStarted);

    const pending = handler(req, res as unknown as NextApiResponse);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(res.statusCode).toBe(302);
    vi.useRealTimers();
  });

  // A sync that loses the race every time looks identical to one that never ran, so the timeout has to say so.
  it('logs when the sync loses the race', async () => {
    vi.useFakeTimers();
    mockSync.mockReturnValue(new Promise(() => undefined));
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/' }, linkStarted);

    const pending = handler(req, res as unknown as NextApiResponse);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'discord-link-sync-timeout' })
    );
    vi.useRealTimers();
  });

  it('does not log a timeout when the sync finishes in time', async () => {
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/' }, linkStarted);
    await handler(req, res as unknown as NextApiResponse);

    expect(mockLog).not.toHaveBeenCalled();
  });
});
