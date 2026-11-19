import { describe, expect, it } from 'vitest';
import { RECORD_VOTED_PAIR_SCRIPT } from '~/server/services/crucible.service';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

/**
 * RECORD_VOTED_PAIR_SCRIPT itself, run in Lua (wasmoon) over an in-memory Redis. The vote-path
 * tests use a JS stand-in for it, so this file is what catches an edit to the Lua: the prize fit
 * freezes exactly the anchors this script records.
 */

const VOTED = 'crucible:voted:1:42';
const ANCHORS = 'crucible:anchor-votes:1:42';
const TTL_SECONDS = 30 * 24 * 60 * 60;

const record = (lua: ReturnType<typeof createLuaRedis>, pairKey: string, anchor: string) =>
  lua.eval(RECORD_VOTED_PAIR_SCRIPT, {
    keys: [VOTED, ANCHORS],
    arguments: [pairKey, anchor, String(TTL_SECONDS)],
  });

describe('RECORD_VOTED_PAIR_SCRIPT', () => {
  it('records the voted pair and its anchor on a first anchored vote', async () => {
    const lua = createLuaRedis(0);
    expect(await record(lua, '10:20', '20')).toBe(1);
    expect(lua.set(VOTED)).toEqual(['10:20']);
    expect(lua.hash(ANCHORS)).toEqual({ '10:20': '20' });
    expect(lua.errors).toEqual([]);
  });

  it('refuses a duplicate vote and keeps the anchor it first recorded', async () => {
    const lua = createLuaRedis(0);
    await record(lua, '10:20', '20');
    expect(await record(lua, '10:20', '10'), 'duplicate').toBe(0);
    expect(lua.hash(ANCHORS)).toEqual({ '10:20': '20' });
  });

  it('sets the 30-day TTL on both keys', async () => {
    const lua = createLuaRedis(0);
    await record(lua, '10:20', '20');
    expect(lua.pttl(VOTED), 'voted set').toBe(TTL_SECONDS * 1000);
    expect(lua.pttl(ANCHORS), 'anchor hash').toBe(TTL_SECONDS * 1000);
  });

  it('refreshes the anchor TTL on a later unanchored vote, so both keys expire together', async () => {
    const lua = createLuaRedis(0);
    await record(lua, '10:20', '20');
    lua.nowMs = 1_000_000;
    await record(lua, '10:30', '');
    expect(lua.pttl(ANCHORS)).toBe(TTL_SECONDS * 1000);
  });

  it('writes no anchor for a vote without one', async () => {
    const lua = createLuaRedis(0);
    expect(await record(lua, '10:30', '')).toBe(1);
    expect(lua.set(VOTED)).toEqual(['10:30']);
    expect(lua.hash(ANCHORS)).toBeUndefined();
  });
});
