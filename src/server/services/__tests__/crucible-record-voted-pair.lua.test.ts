import { describe, expect, it } from 'vitest';
import { RECORD_VOTED_PAIR_SCRIPT } from '~/server/services/crucible.service';
import { getAnchorVotesKey, getVotedPairsKey } from '~/server/services/crucible-redis-keys';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { keyHashSlot, rejectCrossSlot } from './crucible-cross-slot';

/**
 * RECORD_VOTED_PAIR_SCRIPT itself, run in Lua (wasmoon) over an in-memory Redis. The vote-path
 * tests use a JS stand-in for it, so this file is what catches an edit to the Lua: the prize fit
 * freezes exactly the anchors this script records.
 */

const VOTED = 'crucible:voted:{1:42}';
const ANCHORS = 'crucible:anchor-votes:{1:42}';
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

describe('RECORD_VOTED_PAIR_SCRIPT on the cache cluster', () => {
  // Pairwise distinct crucible and user ids, including two that share each.
  const judges: [number, number][] = [
    [1, 42],
    [2, 42],
    [1, 43],
    [123, 4567],
  ];

  /** The script as the cluster runs it: refused (CROSSSLOT) unless every key is in one slot. */
  const clusterRecord = (lua: ReturnType<typeof createLuaRedis>, keys: string[]) => {
    rejectCrossSlot(keys);
    return lua.eval(RECORD_VOTED_PAIR_SCRIPT, {
      keys,
      arguments: ['10:20', '20', String(TTL_SECONDS)],
    });
  };

  it('is handed both keys under the judge’s {crucibleId:userId} tag', () => {
    expect(getVotedPairsKey(1, 42)).toBe(VOTED);
    expect(getAnchorVotesKey(1, 42)).toBe(ANCHORS);
    expect(getVotedPairsKey(123, 4567)).toBe('crucible:voted:{123:4567}');
    expect(getAnchorVotesKey(123, 4567)).toBe('crucible:anchor-votes:{123:4567}');
  });

  it.each(judges)(
    'runs with the keys the vote path passes, without CROSSSLOT (crucible %i, judge %i)',
    async (crucibleId, userId) => {
      const lua = createLuaRedis(0);
      const keys = [getVotedPairsKey(crucibleId, userId), getAnchorVotesKey(crucibleId, userId)];
      expect(await clusterRecord(lua, keys)).toBe(1);
      expect(lua.set(keys[0])).toEqual(['10:20']);
      expect(lua.hash(keys[1])).toEqual({ '10:20': '20' });
    }
  );

  it('control: the cluster refuses the script over the untagged sysRedis-era keys', async () => {
    const lua = createLuaRedis(0);
    await expect(
      (async () => clusterRecord(lua, ['crucible:voted:1:42', 'crucible:anchor-votes:1:42']))()
    ).rejects.toThrow('CROSSSLOT');
  });

  // Invariant guard, not a regression test: a tag shared by every judge (say `{crucible}`) would
  // pass the CROSSSLOT tests above and put every judge's keys in one slot.
  it('spreads different judges across slots', () => {
    const slots = new Set(judges.map(([c, u]) => keyHashSlot(getVotedPairsKey(c, u))));
    expect(slots.size).toBe(judges.length);
  });
});
