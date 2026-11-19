import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

// A `?token=` that is a configured webhook token is never looked up as an API key.

const h = vi.hoisted(() => ({
  getSessionFromBearerToken: vi.fn(async () => null),
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

const CURRENT = 'c'.repeat(40);
const PREVIOUS = 'p'.repeat(40);

async function lookedUpAsApiKey(token: string) {
  h.getSessionFromBearerToken.mockClear();
  const req = { url: `/api/v1/models?token=${token}`, headers: {}, cookies: {} };
  await getServerAuthSession({ req: req as never, res: {} as never });
  return h.getSessionFromBearerToken.mock.calls.length > 0;
}

beforeEach(() => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: CURRENT, WEBHOOK_TOKEN_PREVIOUS: PREVIOUS });
});

describe('getServerAuthSession with a webhook token in ?token=', () => {
  it('does not look up the current or the previous webhook token as an API key', async () => {
    expect(await lookedUpAsApiKey(CURRENT)).toBe(false);
    expect(await lookedUpAsApiKey(PREVIOUS)).toBe(false);
  });

  it('looks up the old value as an API key once WEBHOOK_TOKEN_PREVIOUS is unset', async () => {
    setEnv({ WEBHOOK_TOKEN_PREVIOUS: undefined });
    expect(await lookedUpAsApiKey(PREVIOUS)).toBe(true);
  });

  it('looks up any other value as an API key', async () => {
    expect(await lookedUpAsApiKey('k'.repeat(40))).toBe(true);
  });
});
