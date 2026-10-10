import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Module-scope allowlists and the router tree; none of them derive the credential fields.
vi.mock('~/server/utils/origin-helpers', () => ({
  isAllowedOriginRequest: () => true,
  hostFromUrl: (v: string) => v,
  allowedOriginHosts: new Set<string>(),
}));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: () => 'blue',
  getAllServerHosts: () => ['civitai.com'],
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: vi.fn(() => ({})),
}));
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/trpc', () => ({
  createCallerFactory: () => (ctx: unknown) => ctx,
}));

const { createContext } = await import('~/server/createContext');

function req(context?: Record<string, unknown>) {
  return {
    headers: {},
    socket: {},
    cookies: {},
    query: {},
    ...(context ? { context } : {}),
  } as unknown as NextApiRequest;
}
const res = () => ({ once: vi.fn(), writableEnded: false } as unknown as NextApiResponse);

describe('createContext credential fields', () => {
  it.each(['User', 'System'])('carries the recorded %s key type', async (apiKeyType) => {
    const ctx = await createContext({
      req: req({ apiKeyId: 5, apiKeyType, subject: { type: 'apiKey', id: 5 } }),
      res: res(),
    });
    expect(ctx.apiKeyType).toBe(apiKeyType);
  });

  it('carries the recorded scope, key id and subject', async () => {
    const credential = {
      tokenScope: TokenScope.UserRead,
      apiKeyId: 5,
      apiKeyType: 'User',
      subject: { type: 'oauth', id: 'client-abc' },
    };
    const ctx = await createContext({ req: req(credential), res: res() });
    expect(ctx).toMatchObject(credential);
  });

  it('gives a session the full scope and no key fields', async () => {
    const ctx = await createContext({ req: req(), res: res() });
    expect(ctx.tokenScope).toBe(TokenScope.Full);
    expect(ctx.apiKeyId).toBeUndefined();
    expect(ctx.apiKeyType).toBeUndefined();
    expect(ctx.subject).toBeUndefined();
  });
});
