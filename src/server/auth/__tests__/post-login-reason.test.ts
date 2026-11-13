import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UrlHelpers from '~/server/utils/url-helpers';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// The login `reason` reaches the referral record through post-login, and the success log names it so
// sign-ups can be attributed per entry point. The log carries only known reasons: the query value is
// whatever the URL held.

const mocks = vi.hoisted(() => ({
  session: { user: { id: 7, createdAt: new Date() } } as unknown,
  runLoginSideEffects: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async () => mocks.session,
}));
vi.mock('~/server/auth/login-side-effects', () => ({
  runLoginSideEffects: mocks.runLoginSideEffects,
}));
vi.mock('~/server/utils/url-helpers', async (orig) => ({
  ...(await orig<typeof UrlHelpers>()),
  getBaseUrl: () => 'https://civitai.example',
}));

import handler from '~/pages/api/auth/post-login';

function createMocks(query: Record<string, string>) {
  const req = { cookies: {}, headers: { host: 'civitai.example' }, query } as never;
  const res = {
    getHeader: () => undefined,
    setHeader: () => res,
    status: () => res,
    send: () => res,
    redirect: () => res,
  };
  return { req, res: res as never };
}

const successLog = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .find((entry) => entry.outcome === 'success');

describe('/api/auth/post-login — login reason', () => {
  beforeEach(() => {
    mocks.runLoginSideEffects.mockReset().mockResolvedValue(undefined);
    loggingMock.logToAxiom.mockClear();
  });

  it.each(['image-upload', 'blur-toggle'])(
    'hands %s to the side effects and names it in the success log',
    async (reason) => {
      const { req, res } = createMocks({ dest: '/generate', reason });
      await handler(req, res);

      expect(mocks.runLoginSideEffects).toHaveBeenCalledWith(
        expect.objectContaining({ loginRedirectReason: reason, isNewUser: true })
      );
      expect(successLog()).toMatchObject({ outcome: 'success', reason });
    }
  );

  // `constructor` is on every object's prototype, so a plain `in` check would log it.
  it.each(['not-a-reason', 'constructor'])(
    'leaves an unknown reason (%s) out of the success log',
    async (reason) => {
      const { req, res } = createMocks({ dest: '/generate', reason });
      await handler(req, res);

      expect(successLog()).toBeDefined();
      expect(successLog()?.reason).toBeUndefined();
    }
  );
});
