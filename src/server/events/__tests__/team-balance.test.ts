import { beforeEach, describe, expect, it } from 'vitest';
import { PLACE_LISTED_JOINER, teamBalanceKeys } from '~/server/events/team-balance';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

// The placement script, run for real in Lua against the harness. The join path that calls it is
// pinned in event-engine.scored-event.test.ts ('join balancing').
const TEAMS = ['Yellow', 'Blue', 'Pink', 'Green'];
const keys = teamBalanceKeys('test-event');
let lua: LuaRedis;

const place = (userId: number) =>
  lua.eval(PLACE_LISTED_JOINER, {
    keys: [keys.manual, keys.list, keys.totals, keys.assigned],
    arguments: [String(userId), ...TEAMS],
  });

beforeEach(() => {
  lua = createLuaRedis(0);
  lua.setHash(keys.list, { '1': '500', '2': '300', '3': '100', '4': '50', '5': '10' });
});

describe('PLACE_LISTED_JOINER', () => {
  it('places a listed user on the team with the lowest total and adds their points to it', async () => {
    lua.setHash(keys.totals, { Yellow: '900', Blue: '200', Pink: '700', Green: '400' });
    expect(await place(1)).toBe('Blue');
    expect(lua.hash(keys.totals)).toEqual({
      Yellow: '900',
      Blue: '700',
      Pink: '700',
      Green: '400',
    });
    expect(lua.hash(keys.manual)).toEqual({ '1': 'Blue' });
    expect(lua.hash(keys.assigned)).toEqual({ '1': 'Blue' });
  });

  // A team with no total yet counts as 0, and ties go to the earliest team.
  it('fills empty teams in order, then the lightest', async () => {
    const placed = [];
    for (const id of [1, 2, 3, 4, 5]) placed.push(await place(id));
    expect(placed).toEqual(['Yellow', 'Blue', 'Pink', 'Green', 'Green']);
    expect(lua.hash(keys.totals)).toEqual({ Yellow: '500', Blue: '300', Pink: '100', Green: '60' });
  });

  it('leaves an unlisted user to the hash, writing nothing', async () => {
    expect(await place(99)).toBeNull();
    expect(lua.hash(keys.totals)).toBeUndefined();
    expect(lua.hash(keys.manual)).toBeUndefined();
    expect(lua.hash(keys.assigned)).toBeUndefined();
  });

  it('keeps an existing manual assignment, counting nothing', async () => {
    lua.setHash(keys.manual, { '1': 'Pink' });
    expect(await place(1)).toBe('Pink');
    expect(lua.hash(keys.totals)).toBeUndefined();
    expect(lua.hash(keys.assigned)).toBeUndefined();
  });

  it('counts a user once however often they join', async () => {
    expect(await place(1)).toBe('Yellow');
    expect(await place(1)).toBe('Yellow');
    expect(lua.hash(keys.totals)).toEqual({ Yellow: '500' });
  });

  it('refuses points that are not a non-negative integer, writing nothing', async () => {
    lua.setHash(keys.list, { '1': '12.5', '2': '-3' });
    await expect(place(1)).rejects.toThrow('not an integer');
    await expect(place(2)).rejects.toThrow('not an integer');
    expect(lua.hash(keys.totals)).toBeUndefined();
    expect(lua.hash(keys.manual)).toBeUndefined();
  });
});
