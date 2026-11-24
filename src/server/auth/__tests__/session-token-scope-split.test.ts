import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import { resetEnv } from '~/__tests__/mocks/env.mock';

// A bearer-token session carries its scope twice: `req.context.session.tokenScope` as a JSON-safe
// number (the session can reach page props), and `req.context.tokenScope` as the bigint every scope
// check reads. A token with bit 31 (AppsRead) set must keep that bit in both, each in its own type.

const h = vi.hoisted(() => ({
  getSessionFromBearerToken: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: h.getSessionFromBearerToken,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async () => null },
  getHubSession: async () => null,
  maybeRollHubCookie: async () => undefined,
}));

const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');

beforeEach(() => {
  resetEnv();
});

describe('getServerAuthSession with a bearer token carrying bit 31', () => {
  it('puts a number on the session and the bigint on req.context.tokenScope', async () => {
    // AppsRead (2^31) | UserRead (1).
    h.getSessionFromBearerToken.mockResolvedValueOnce({
      user: { id: 7 },
      tokenScope: 2147483649n,
    });
    const req: {
      headers: Record<string, string>;
      cookies: object;
      context?: { session?: { tokenScope?: unknown }; tokenScope?: unknown };
    } = {
      headers: { authorization: 'Bearer abc' },
      cookies: {},
    };
    const session = await getServerAuthSession({ req: req as never, res: {} as never });

    expect(typeof req.context?.session?.tokenScope).toBe('number');
    expect(req.context?.session?.tokenScope).toBe(2147483649);
    expect((session as { tokenScope?: unknown } | null)?.tokenScope).toBe(2147483649);

    expect(typeof req.context?.tokenScope).toBe('bigint');
    expect(req.context?.tokenScope).toBe(2147483649n);
  });
});
