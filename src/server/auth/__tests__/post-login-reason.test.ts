import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UrlHelpers from '~/server/utils/url-helpers';

// The login `reason` reaches the referral record through post-login, and the success log names it so
// sign-ups can be attributed per entry point. The log carries only known reasons: the query value is
// whatever the URL held.

const mocks = vi.hoisted(() => ({
  session: { user: { id: 7, createdAt: new Date() } } as unknown,
  runLoginSideEffects: vi.fn(),
  logToAxiom: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async () => mocks.session,
}));
vi.mock('~/server/auth/login-side-effects', () => ({
  runLoginSideEffects: mocks.runLoginSideEffects,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mocks.logToAxiom }));
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
  mocks.logToAxiom.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .find((entry) => entry.outcome === 'success');

describe('/api/auth/post-login — login reason', () => {
  beforeEach(() => {
    mocks.runLoginSideEffects.mockReset().mockResolvedValue(undefined);
    mocks.logToAxiom.mockReset().mockResolvedValue(undefined);
  });

  it('hands the upload reason to the side effects and names it in the success log', async () => {
    const { req, res } = createMocks({ dest: '/generate', reason: 'image-upload' });
    await handler(req, res);

    expect(mocks.runLoginSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ loginRedirectReason: 'image-upload', isNewUser: true })
    );
    expect(successLog()).toMatchObject({ outcome: 'success', reason: 'image-upload' });
  });

  it('leaves an unknown reason out of the success log', async () => {
    const { req, res } = createMocks({ dest: '/generate', reason: 'not-a-reason' });
    await handler(req, res);

    expect(successLog()).toBeDefined();
    expect(successLog()?.reason).toBeUndefined();
  });
});
