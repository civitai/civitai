import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/utils/endpoint-helpers')>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/v1/me')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const MOD = { id: 1, username: 'mod', isModerator: true, email: 'm@x.test' } as SessionUser;
const NORMIE = { id: 2, username: 'normie', isModerator: false } as SessionUser;

async function me(user: SessionUser, context: Record<string, unknown> = {}) {
  let body: Record<string, unknown> | undefined;
  const req = { method: 'GET', headers: {}, query: {}, context } as unknown as NextApiRequest;
  const res = {
    send(value: Record<string, unknown>) {
      body = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, user);
  return body!;
}

const token = (tokenScope: number) => ({
  tokenScope,
  buzzLimit: null,
  subject: { type: 'oauth', id: 'client-1' },
});

describe('GET /api/v1/me isModerator', () => {
  it('reports a moderator on a session', async () => {
    expect((await me(MOD)).isModerator).toBe(true);
  });

  it('reports false, not absent, for a non-moderator on a session', async () => {
    const body = await me(NORMIE);
    expect(body).toHaveProperty('isModerator', false);
  });

  it('reports false when the session user carries no isModerator at all', async () => {
    const { isModerator: _, ...noFlag } = NORMIE;
    expect(await me(noFlag as SessionUser)).toHaveProperty('isModerator', false);
  });

  it('reports a moderator to a token holding UserRead', async () => {
    expect((await me(MOD, token(TokenScope.UserRead))).isModerator).toBe(true);
  });

  // Deliberate: moderator status is gated exactly like email, so an arbitrary OAuth app without
  // UserRead cannot enumerate moderators. Do not "simplify" this into an always-present field.
  it('omits isModerator entirely for a token without UserRead', async () => {
    const withoutUserRead = TokenScope.Full & ~TokenScope.UserRead;
    const body = await me(MOD, token(withoutUserRead));
    expect(body).not.toHaveProperty('isModerator');
    expect(body).not.toHaveProperty('email');
    expect(body.id).toBe(MOD.id);
  });
});
