import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Invites from '$lib/server/oauth/invites';

const ORIGIN = 'https://advertising.civitai.com';
const INVITE = { clientId: 'ads', email: 'bob@example.com', returnUrl: `${ORIGIN}/invite/abc` };

const mocks = vi.hoisted(() => ({
  findInvite: vi.fn(),
  consumeInviteToken: vi.fn(),
  inviteSender: vi.fn(),
  newAccountRefusal: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
  establishSession: vi.fn(),
}));

vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('$lib/server/auth/invite-tokens', () => ({
  consumeInviteToken: mocks.consumeInviteToken,
  findInvite: mocks.findInvite,
}));
vi.mock('$lib/server/oauth/invites', async (importOriginal) => ({
  ...(await importOriginal<typeof Invites>()),
  inviteSender: mocks.inviteSender,
}));
vi.mock('$lib/server/auth/signup-rules', () => ({ newAccountRefusal: mocks.newAccountRefusal }));
vi.mock('$lib/server/auth/users', () => {
  class SystemAccountSignInError extends Error {}
  return {
    findOrCreateUserByEmail: mocks.findOrCreateUserByEmail,
    userExistsByEmail: vi.fn(async () => false),
    SystemAccountSignInError,
  };
});
vi.mock('$lib/server/auth/session', () => ({ establishSession: mocks.establishSession }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: vi.fn(async () => (origin: string) => origin === ORIGIN),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/metrics', () => ({ loginsTotal: { inc: vi.fn() } }));

import { actions, load } from '../+page.server';

async function accept(token = 'raw-token') {
  const body = new FormData();
  body.set('token', token);
  const request = new Request('https://auth.civitai.com/invite', { method: 'POST', body });
  try {
    return await actions.default({
      request,
      cookies: {},
      url: new URL('https://auth.civitai.com/invite'),
    } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findInvite.mockResolvedValue(INVITE);
  mocks.consumeInviteToken.mockResolvedValue(INVITE);
  mocks.inviteSender.mockResolvedValue({
    id: 'ads',
    name: 'Ads',
    allowedOrigins: [ORIGIN],
  });
  mocks.newAccountRefusal.mockResolvedValue(null);
  mocks.findOrCreateUserByEmail.mockResolvedValue({ id: 42 });
});

describe('accepting an invite', () => {
  it('signs the invited address in, spends the link and lands on the returnUrl', async () => {
    const result = await accept();
    expect(result).toMatchObject({ status: 303, location: INVITE.returnUrl });
    expect(mocks.consumeInviteToken).toHaveBeenCalledWith('raw-token');
    expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith(INVITE.email, { allowCreate: true });
    expect(mocks.establishSession).toHaveBeenCalledWith(
      {},
      { id: 42 },
      {
        returnUrl: INVITE.returnUrl,
      }
    );
  });

  it('refuses a used, unknown or expired link', async () => {
    mocks.findInvite.mockResolvedValue(null);
    expect(await accept()).toMatchObject({ status: 410 });
    expect(mocks.establishSession).not.toHaveBeenCalled();
  });

  it('does not sign in when the token was spent between the check and the consume', async () => {
    mocks.consumeInviteToken.mockResolvedValue(null);
    expect(await accept()).toMatchObject({ status: 410 });
    expect(mocks.findOrCreateUserByEmail).not.toHaveBeenCalled();
    expect(mocks.establishSession).not.toHaveBeenCalled();
  });

  it('refuses once the app has been disabled', async () => {
    mocks.inviteSender.mockResolvedValue(null);
    expect(await accept()).toMatchObject({ status: 410 });
    expect(mocks.establishSession).not.toHaveBeenCalled();
  });

  it('refuses once the returnUrl origin is no longer registered for the app', async () => {
    mocks.inviteSender.mockResolvedValue({
      id: 'ads',
      name: 'Ads',
      allowedOrigins: [],
    });
    expect(await accept()).toMatchObject({ status: 410 });
    expect(mocks.establishSession).not.toHaveBeenCalled();
  });

  it('refuses an address that may no longer start an account, without spending the link', async () => {
    mocks.newAccountRefusal.mockResolvedValue('blockedDomain');
    expect(await accept()).toMatchObject({ status: 403 });
    expect(mocks.consumeInviteToken).not.toHaveBeenCalled();
    expect(mocks.establishSession).not.toHaveBeenCalled();
  });
});

describe('the invite page', () => {
  it('refuses to be framed by another site', async () => {
    const setHeaders = vi.fn();
    await load({ url: new URL('https://auth.civitai.com/invite?token=t'), setHeaders } as never);
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ 'content-security-policy': "frame-ancestors 'none'" })
    );
  });
});
