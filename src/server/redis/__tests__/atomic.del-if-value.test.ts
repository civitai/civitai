import { describe, expect, it, vi } from 'vitest';
import { delIfValue } from '../atomic';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

describe('delIfValue', () => {
  it('deletes the key while it still holds the value, and says so', async () => {
    const lua = createLuaRedis(0);
    lua.setString('lock', 'token-a');

    expect(await delIfValue(lua, 'lock', 'token-a')).toBe(true);
    expect(lua.string('lock')).toBeUndefined();
    expect(lua.errors).toEqual([]);
  });

  it('leaves a key that holds another value, and says it did not delete', async () => {
    const lua = createLuaRedis(0);
    // Someone else's lock now: the one this caller took expired and was taken again.
    lua.setString('lock', 'token-b');

    expect(await delIfValue(lua, 'lock', 'token-a')).toBe(false);
    expect(lua.string('lock')).toBe('token-b');
    expect(lua.errors).toEqual([]);
  });

  it('answers false for a key that is not there', async () => {
    const lua = createLuaRedis(0);

    expect(await delIfValue(lua, 'lock', 'token-a')).toBe(false);
    expect(lua.calls.map(([command]) => command)).toEqual(['GET']);
  });

  it('reads and deletes in one script, so nothing can write between the two', async () => {
    const lua = createLuaRedis(0);
    lua.setString('lock', 'token-a');
    const client = { eval: vi.fn(lua.eval) };

    await delIfValue(client, 'lock', 'token-a');

    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(lua.calls).toEqual([
      ['GET', 'lock'],
      ['DEL', 'lock'],
    ]);
  });
});
