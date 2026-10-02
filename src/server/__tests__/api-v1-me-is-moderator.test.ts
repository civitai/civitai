import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/v1/me')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const MOD = { id: 1, username: 'mod', isModerator: true, email: 'm@x.test' } as SessionUser;
const NORMIE = { id: 2, username: 'normie', isModerator: false, email: 'n@x.test' } as SessionUser;

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
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
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

  it('reports a moderator who has no email', async () => {
    const { email: _, ...noEmail } = MOD;
    expect(await me(noEmail as SessionUser)).toHaveProperty('isModerator', true);
  });

  // Deliberate: the key is never `false`. A non-moderator must be indistinguishable from a caller
  // the gate withheld the field from. Do not "normalise" this into an always-boolean field.
  it('omits isModerator for a non-moderator on a session rather than sending false', async () => {
    expect(await me(NORMIE)).not.toHaveProperty('isModerator');
  });

  it('omits isModerator when the session user carries no isModerator at all', async () => {
    const { isModerator: _, email: __, ...noFlag } = NORMIE;
    expect(await me(noFlag as SessionUser)).not.toHaveProperty('isModerator');
  });

  it('omits isModerator for a non-moderator token holding UserRead', async () => {
    expect(await me(NORMIE, token(TokenScope.UserRead))).not.toHaveProperty('isModerator');
  });

  it('reports a moderator to a token holding UserRead', async () => {
    expect((await me(MOD, token(TokenScope.UserRead))).isModerator).toBe(true);
  });

  // Deliberate: moderator status is gated exactly like email, so an arbitrary OAuth app without
  // UserRead cannot enumerate moderators. Do not "simplify" this into an always-present field.
  it('reveals nothing about moderator status to a token without UserRead', async () => {
    const withoutUserRead = token(TokenScope.Full & ~TokenScope.UserRead);
    const asMod = await me(MOD, withoutUserRead);
    const asNonMod = await me({ ...MOD, isModerator: false }, withoutUserRead);

    expect(asMod).not.toHaveProperty('isModerator');
    expect(asMod).not.toHaveProperty('email');
    expect(asMod.id).toBe(MOD.id);
    expect(asMod).toEqual(asNonMod);
  });
});
