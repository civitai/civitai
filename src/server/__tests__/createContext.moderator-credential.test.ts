import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { constants } from '~/server/common/constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const session = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));

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
  getServerAuthSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
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

const userKey = (tokenScope: bigint, id = 5) => ({
  tokenScope,
  apiKeyId: id,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id },
});

async function moderatorFlag(user: Record<string, unknown>, credential?: Record<string, unknown>) {
  session.user = user;
  const ctx = await createContext({ req: req(credential), res: res() });
  return ctx.user?.isModerator;
}

const moderator = { id: 42, isModerator: true };

describe('createContext moderator rights by credential', () => {
  it('keeps them on a browser session', async () => {
    expect(await moderatorFlag(moderator)).toBe(true);
  });

  it('keeps them on a full-scope personal key', async () => {
    expect(await moderatorFlag(moderator, userKey(TokenScope.Full))).toBe(true);
  });

  it('withholds them on a scoped personal key', async () => {
    expect(await moderatorFlag(moderator, userKey(TokenScope.UserRead))).toBe(false);
  });

  it('withholds them on an app token, even a full-scope one', async () => {
    const oauth = {
      tokenScope: TokenScope.Full,
      apiKeyId: 5,
      apiKeyType: 'User',
      subject: { type: 'oauth', id: 'client-abc' },
    };
    expect(await moderatorFlag(moderator, oauth)).toBe(false);
  });

  it("keeps the system account's on its read-scoped keys", async () => {
    const system = { id: constants.system.user.id, isModerator: true };
    expect(await moderatorFlag(system, userKey(TokenScope.UserRead, 9))).toBe(true);
  });

  it('leaves the rest of the viewer as the session has it', async () => {
    session.user = { ...moderator, username: 'mod' };
    const ctx = await createContext({ req: req(userKey(TokenScope.UserRead)), res: res() });
    expect(ctx.user).toMatchObject({ id: 42, username: 'mod', isModerator: false });
  });
});
