import { describe, it, expect } from 'vitest';
import { hSetMultiWithTTLUnlessValue } from '../atomic';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

describe('hSetMultiWithTTLUnlessValue', () => {
  it('writes every field except those already holding keepValue, across chunks', async () => {
    const lua = createLuaRedis(0, { integerArgs: true });
    const ids = Array.from({ length: 2500 }, (_, i) => `t-${i}`);
    const kept = ['t-0', 't-999', 't-1000', 't-2499'];
    lua.setHash('state', Object.fromEntries(kept.map((id) => [id, 'invalid'])));
    lua.nowMs = 5_000;

    await hSetMultiWithTTLUnlessValue(
      lua,
      'state',
      Object.fromEntries(ids.map((id) => [id, 'refresh'])),
      60_000,
      'invalid'
    );

    const state = lua.hash('state') ?? {};
    expect(Object.keys(state)).toHaveLength(2500);
    for (const id of kept) {
      expect(state[id]).toBe('invalid');
      expect(lua.hpttl('state', id)).toBe(-1);
    }
    expect(state['t-1']).toBe('refresh');
    expect(state['t-2498']).toBe('refresh');
    expect(lua.hpttl('state', 't-1')).toBe(60_000);
    expect(lua.errors).toEqual([]);
  });

  it('writes nothing when every field already holds keepValue', async () => {
    const lua = createLuaRedis(0, { integerArgs: true });
    lua.setHash('state', { a: 'invalid' });

    await hSetMultiWithTTLUnlessValue(lua, 'state', { a: 'refresh' }, 60_000, 'invalid');

    expect(lua.hash('state')).toEqual({ a: 'invalid' });
    expect(lua.calls.map(([command]) => command)).toEqual(['HMGET']);
  });
});
