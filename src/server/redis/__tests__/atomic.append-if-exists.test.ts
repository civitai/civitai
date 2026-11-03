import { describe, expect, it } from 'vitest';
import { sAddIfExistsWithTTL } from '../atomic';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

describe('sAddIfExistsWithTTL', () => {
  it('appends to an existing set and refreshes its expiry', async () => {
    const lua = createLuaRedis(0);
    lua.setSet('rated', ['0']);

    expect(await sAddIfExistsWithTTL(lua, 'rated', '7', 5000)).toBe(true);
    expect(lua.set('rated')).toEqual(['0', '7']);
    expect(lua.pttl('rated')).toBe(5000);
    expect(lua.errors).toEqual([]);
  });

  it('leaves a missing key missing', async () => {
    const lua = createLuaRedis(0);

    expect(await sAddIfExistsWithTTL(lua, 'rated', '7', 5000)).toBe(false);
    expect(lua.set('rated')).toBeUndefined();
    expect(lua.errors).toEqual([]);
  });
});
