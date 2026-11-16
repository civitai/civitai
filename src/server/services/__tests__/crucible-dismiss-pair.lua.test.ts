import { describe, expect, it } from 'vitest';
import { DISMISS_SERVED_PAIR_SCRIPT } from '~/server/services/crucible.service';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

/**
 * DISMISS_SERVED_PAIR_SCRIPT itself, run in Lua (wasmoon) over an in-memory Redis. The service
 * tests use a JS stand-in for it, so this file is what catches an edit to the Lua.
 */

const SERVED = 'crucible:served-pair:1:42';
const DISMISSED = 'crucible:dismissed-pairs:1:42';
const TTL_SECONDS = 30 * 24 * 60 * 60;

const dismiss = (lua: ReturnType<typeof createLuaRedis>, pairKey: string) =>
  lua.eval(DISMISS_SERVED_PAIR_SCRIPT, {
    keys: [SERVED, DISMISSED],
    arguments: [pairKey, String(TTL_SECONDS)],
  });

describe('DISMISS_SERVED_PAIR_SCRIPT', () => {
  it('dismisses the served pair and claims it, so it cannot be voted', async () => {
    const lua = createLuaRedis(0);
    lua.setString(SERVED, '10:20');
    expect(await dismiss(lua, '10:20')).toBe(1);
    expect(lua.set(DISMISSED)).toEqual(['10:20']);
    expect(lua.string(SERVED), 'served pair claimed').toBeUndefined();
    expect(lua.pttl(DISMISSED)).toBe(TTL_SECONDS * 1000);
    expect(lua.errors).toEqual([]);
  });

  it('dismisses a pair served with an anchor', async () => {
    const lua = createLuaRedis(0);
    lua.setString(SERVED, '10:20|anchor:20');
    expect(await dismiss(lua, '10:20')).toBe(1);
    expect(lua.set(DISMISSED)).toEqual(['10:20']);
  });

  it('refuses a pair other than the one served, and leaves the served pair votable', async () => {
    const lua = createLuaRedis(0);
    lua.setString(SERVED, '10:20');
    expect(await dismiss(lua, '10:30')).toBe(0);
    expect(lua.string(SERVED)).toBe('10:20');
    expect(lua.set(DISMISSED)).toBeUndefined();
  });

  it('refuses a pair whose key is only a prefix of the served one', async () => {
    const lua = createLuaRedis(0);
    lua.setString(SERVED, '10:200');
    expect(await dismiss(lua, '10:20')).toBe(0);
    expect(lua.string(SERVED)).toBe('10:200');
  });

  it('refuses when nothing is served', async () => {
    const lua = createLuaRedis(0);
    expect(await dismiss(lua, '10:20')).toBe(0);
    expect(lua.set(DISMISSED)).toBeUndefined();
  });
});
