import { describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';
import type * as SideEffectsModule from '~/server/auth/login-side-effects';
import type * as ServerUrlHelpers from '~/server/utils/url-helpers';

import {
  SAFE_RETURN_PATHS,
  UNSAFE_RETURN_PATHS,
} from '../../../../packages/civitai-auth/src/__tests__/return-path-cases';

// The post-login and logout API routes each redirect to a caller-supplied path. These pin that the
// value reaching `res.redirect` is the shared same-origin rule's output, end to end through each handler.

// No hub configured: logout takes its same-site branch and redirects straight to the callback path.
const { BASE_URL } = vi.hoisted(() => {
  delete process.env.AUTH_JWT_ISSUER;
  return { BASE_URL: 'https://civitai.example' };
});

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getServerAuthSession: vi.fn(async () => ({ user: { id: 1, createdAt: '2020-01-01' } })),
}));
vi.mock('~/server/auth/login-side-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof SideEffectsModule>()),
  runLoginSideEffects: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/url-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerUrlHelpers>()),
  getBaseUrl: () => BASE_URL,
}));

import postLogin from '~/pages/api/auth/post-login';
import logout from '~/pages/api/auth/logout';

function createMocks(query: Record<string, unknown>) {
  const req = { cookies: {}, headers: { host: 'civitai.example' }, query } as never;
  let redirectedTo: string | undefined;
  const res = {
    status: () => res,
    setHeader: () => res,
    getHeader: () => undefined,
    send: () => res,
    redirect(_code: number, url: string) {
      redirectedTo = url;
      return res;
    },
  };
  return { req, res: res as never, redirectedTo: () => redirectedTo };
}

describe('/api/auth/post-login dest', () => {
  it.each(UNSAFE_RETURN_PATHS)('redirects to / for: %s', async (_name, raw) => {
    const { req, res, redirectedTo } = createMocks({ dest: raw });
    await postLogin(req, res);
    expect(redirectedTo()).toBe('/');
  });

  it.each(SAFE_RETURN_PATHS)('redirects to the path for: %s', async (_name, raw, expected) => {
    const { req, res, redirectedTo } = createMocks({ dest: raw });
    await postLogin(req, res);
    expect(redirectedTo()).toBe(expected);
  });

  it('reduces an absolute url on the base origin to its path', async () => {
    const { req, res, redirectedTo } = createMocks({ dest: `${BASE_URL}/a/b?c=1#d` });
    await postLogin(req, res);
    expect(redirectedTo()).toBe('/a/b?c=1#d');
  });

  it('rejects an absolute url on the base origin whose normalised path is not same-origin', async () => {
    const { req, res, redirectedTo } = createMocks({ dest: `${BASE_URL}/.//other.example` });
    await postLogin(req, res);
    expect(redirectedTo()).toBe('/');
  });

  it('redirects to / for a repeated query param', async () => {
    const { req, res, redirectedTo } = createMocks({ dest: ['/a', '/b'] });
    await postLogin(req, res);
    expect(redirectedTo()).toBe('/');
  });
});

describe('/api/auth/logout callbackUrl', () => {
  it.each(UNSAFE_RETURN_PATHS)('redirects to / for: %s', async (_name, raw) => {
    const { req, res, redirectedTo } = createMocks({ callbackUrl: raw });
    await logout(req, res);
    expect(redirectedTo()).toBe('/');
  });

  it.each(SAFE_RETURN_PATHS)('redirects to the path for: %s', async (_name, raw, expected) => {
    const { req, res, redirectedTo } = createMocks({ callbackUrl: raw });
    await logout(req, res);
    expect(redirectedTo()).toBe(expected);
  });
});
