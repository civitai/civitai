import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../../../test/sys-redis.fake';

// Signing out at the hub ends every session signed in on that browser, on every site and account. Runs the
// real route, lineage records and session registry over an in-memory sys redis.

const h = vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  delete process.env.AUTH_COOKIE_DOMAIN;
  return { sys: undefined as unknown as SysRedisFake };
});
vi.mock('$lib/server/redis', () => ({ getSysRedis: () => h.sys, getRedis: () => null }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: async () => () => true,
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));

import { REDIS_SYS_KEYS } from '@civitai/redis';
import { POST } from '../+server';
import { sessions } from '$lib/server/auth/registry';

const DEVICE = 'device-1';
const familiesKey = `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${DEVICE}`;
const accountsKey = `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${DEVICE}`;

const cookies = {
  get: () => undefined,
  getAll: () => [],
  set: () => undefined,
  delete: () => undefined,
  serialize: () => '',
};

async function logout(locals: Record<string, unknown>) {
  try {
    await POST({
      cookies,
      locals,
      url: new URL('https://auth.civitai.com/logout?returnUrl=https://civitai.com/'),
    } as never);
  } catch (e) {
    if ((e as { status?: number }).status !== 302) throw e;
  }
}

const revoked = (claims: { jti: string; sid?: string }) =>
  sessions.isRevoked({ ...claims, signedAt: Date.now() });

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
});

describe('POST /logout', () => {
  it('ends every family signed in on the browser and forgets its account list', async () => {
    await h.sys.sAdd(familiesKey, ['family-a', 'family-b']);
    await h.sys.hSet(accountsKey, '100', '1');
    await h.sys.hSet(accountsKey, '200', '1');

    await logout({
      user: { id: 100 },
      tokenId: 'hub-jti',
      session: { sub: '100', jti: 'hub-jti', sid: 'family-a' },
      deviceId: DEVICE,
    });

    expect(await revoked({ jti: 'moderator-session', sid: 'family-a' })).toBe(true);
    expect(await revoked({ jti: 'added-account-session', sid: 'family-b' })).toBe(true);
    expect(h.sys.hashes.has(accountsKey)).toBe(false);
    expect(h.sys.sets.has(familiesKey)).toBe(false);
  });

  it("leaves a device's sessions alone when the caller's family never signed in on it", async () => {
    await h.sys.sAdd(familiesKey, ['family-b']);
    await h.sys.hSet(accountsKey, '200', '1');

    await logout({
      user: { id: 100 },
      tokenId: 'hub-jti',
      session: { sub: '100', jti: 'hub-jti', sid: 'family-a' },
      deviceId: DEVICE,
    });

    expect(await revoked({ jti: 'x', sid: 'family-a' })).toBe(true);
    expect(await revoked({ jti: 'y', sid: 'family-b' })).toBe(false);
    expect(h.sys.hashes.has(accountsKey)).toBe(true);
  });
});
