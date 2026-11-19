import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findOrCreateUserByEmail: vi.fn(), establishSession: vi.fn() }));

vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('$lib/server/auth/email-tokens', () => ({
  consumeVerificationToken: vi.fn(async () => true),
}));
vi.mock('$lib/server/auth/users', () => {
  class NoAccountForEmailError extends Error {}
  class SystemAccountSignInError extends Error {}
  return {
    findOrCreateUserByEmail: mocks.findOrCreateUserByEmail,
    NoAccountForEmailError,
    SystemAccountSignInError,
  };
});
vi.mock('$lib/server/auth/session', () => ({ establishSession: mocks.establishSession }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: vi.fn(async () => () => false),
}));
vi.mock('$lib/server/metrics', () => ({ loginsTotal: { inc: vi.fn() } }));

import { NoAccountForEmailError, SystemAccountSignInError } from '$lib/server/auth/users';
import { lastMethodCookieName } from '$lib/server/auth/last-method';
import { GET } from '../+server';

const cookies = { get: vi.fn(), set: vi.fn() };
const lastMethodWrites = () =>
  cookies.set.mock.calls.filter(([name]) => name === lastMethodCookieName());

async function visit(email: string) {
  const url = new URL('https://auth.civitai.com/login/email/verify');
  url.searchParams.set('token', 't');
  url.searchParams.set('email', email);
  try {
    await GET({ url, cookies } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrCreateUserByEmail.mockResolvedValue({ id: 1 });
  mocks.establishSession.mockResolvedValue(undefined);
});

describe('magic-link landing', () => {
  it('lets a plain address create an account', async () => {
    await visit('new@ok.test');

    expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith('new@ok.test', {
      allowCreate: true,
      lastMethod: null,
    });
  });

  it.each(['"new"@ok.test', 'new@ｏｋ.test'])(
    'lets %j sign in only to an account that already has it',
    async (email) => {
      await visit(email);

      expect(mocks.findOrCreateUserByEmail).toHaveBeenCalledWith(expect.any(String), {
        allowCreate: false,
        lastMethod: null,
      });
    }
  );

  it('sends a link with no matching account back to sign-in', async () => {
    mocks.findOrCreateUserByEmail.mockRejectedValue(new NoAccountForEmailError());

    const result = await visit('"new"@ok.test');

    expect(result).toMatchObject({ status: 302, location: '/login?error=Verification' });
  });
});

describe('remembering the sign-in method', () => {
  it('records email once the session is established', async () => {
    await visit('new@ok.test');
    expect(lastMethodWrites().map(([, value]) => value)).toEqual(['email']);
  });

  it('records nothing when the session cannot be established', async () => {
    mocks.establishSession.mockRejectedValue(new Error('refused'));
    expect(await visit('new@ok.test')).toMatchObject({ message: 'refused' });
    expect(lastMethodWrites()).toEqual([]);
  });

  it('records nothing when the account may not sign in', async () => {
    mocks.findOrCreateUserByEmail.mockRejectedValue(new SystemAccountSignInError());
    expect(await visit('new@ok.test')).toMatchObject({ location: '/login?error=SystemAccount' });
    expect(lastMethodWrites()).toEqual([]);
  });
});
