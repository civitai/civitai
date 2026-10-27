import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

// Runs refreshSession / invalidateSession against the real hSetMultiWithTTL scripts, executed in Lua
// over an in-memory store, and reads the result back through the real isRevoked.

const { mockLogSysRedisFailOpen } = vi.hoisted(() => ({ mockLogSysRedisFailOpen: vi.fn() }));
let lua: LuaRedis;

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../session-cache', () => ({
  clearSessionCache: vi.fn().mockResolvedValue(undefined),
}));

vi.unmock('~/server/auth/session-invalidation');

import { refreshSession, invalidateSession } from '../session-invalidation';
import { isRevoked } from '../session-verifier';

const USER_ID = 42;
const USER_TOKENS = `${REDIS_KEYS.SESSION.USER_TOKENS}:${USER_ID}`;
const TOKEN_STATE = REDIS_SYS_KEYS.SESSION.TOKEN_STATE;

const revoked = (jti: string) => isRevoked({ jti } as Parameters<typeof isRevoked>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  lua = createLuaRedis(Date.UTC(2026, 9, 26), { integerArgs: true });
  lua.setHash(USER_TOKENS, { 'token-a': '1', 'token-b': '1' });
  const { sysRedis } = redisMock;
  sysRedis.eval.mockImplementation((script: string, options: Parameters<LuaRedis['eval']>[1]) =>
    lua.eval(script, options)
  );
  sysRedis.hScanNoValues.mockImplementation(async (key: string) => ({
    cursor: '0',
    fields: Object.keys(lua.hash(key) ?? {}),
  }));
  sysRedis.hGet.mockImplementation(
    async (key: string, field: string) => lua.hash(key)?.[field] ?? null
  );
  sysRedis.hDel.mockImplementation((key: string, fields: string[]) =>
    lua.eval(`return redis.call('HDEL', KEYS[1], unpack(ARGV))`, { keys: [key], arguments: fields })
  );
});

describe('session token state', () => {
  it('keeps signed-out tokens signed out when the session is refreshed afterwards', async () => {
    await invalidateSession(USER_ID);
    await refreshSession(USER_ID, { sendSignal: false });

    expect(lua.hash(TOKEN_STATE)).toMatchObject({
      'token-a': 'invalid',
      'token-b': 'invalid',
    });
    expect(await revoked('token-a')).toBe(true);
    expect(await revoked('token-b')).toBe(true);
    expect(lua.errors).toEqual([]);
  });

  it('refresh marks never-signed-out tokens for refresh, beside a signed-out one', async () => {
    lua.setHash(TOKEN_STATE, { 'token-a': 'invalid' });

    await refreshSession(USER_ID, { sendSignal: false });

    expect(lua.hash(TOKEN_STATE)).toEqual({ 'token-a': 'invalid', 'token-b': 'refresh' });
    expect(lua.hpttl(TOKEN_STATE, 'token-b')).toBe(91 * 24 * 60 * 60 * 1000);
    expect(await revoked('token-a')).toBe(true);
    expect(await revoked('token-b')).toBe(false);
    expect(lua.errors).toEqual([]);
  });

  it('sign-out marks every token invalid and stops tracking them', async () => {
    await invalidateSession(USER_ID);

    expect(lua.hash(TOKEN_STATE)).toEqual({ 'token-a': 'invalid', 'token-b': 'invalid' });
    expect(lua.hpttl(TOKEN_STATE, 'token-a')).toBe(91 * 24 * 60 * 60 * 1000);
    expect(await revoked('token-a')).toBe(true);
    expect(lua.hash(USER_TOKENS)).toBeUndefined();
    expect(lua.errors).toEqual([]);
  });

  it('keeps tracking the tokens when the sign-out marker write fails', async () => {
    vi.spyOn(lua, 'eval').mockRejectedValueOnce(new Error('READONLY'));

    await expect(invalidateSession(USER_ID)).resolves.toBeUndefined();

    expect(lua.hash(TOKEN_STATE)).toBeUndefined();
    expect(lua.hash(USER_TOKENS)).toEqual({ 'token-a': '1', 'token-b': '1' });
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'session-invalidation.updateSessionState',
      expect.any(Error),
      expect.objectContaining({ userId: USER_ID, type: 'invalid' })
    );

    // A retry after recovery still finds them.
    await invalidateSession(USER_ID);
    expect(await revoked('token-a')).toBe(true);
  });
});
