import { createLuaRedis } from '../../../../src/server/utils/__tests__/redis-lua-harness';

// The sys redis client surface the device account list uses, over the real-Lua harness: scripts run in Lua,
// and the plain reads go straight to the harness store.
export function luaSysRedis() {
  const lua = createLuaRedis(Date.now());
  return {
    lua,
    eval: lua.eval,
    // The same script @civitai/redis runs for hSetMultiWithExpire.
    async hSetMultiWithExpire(key: string, fields: string[], ttlSeconds: number) {
      return lua.eval(
        `local added = redis.call('HSET', KEYS[1], unpack(ARGV, 2))
         redis.call('EXPIRE', KEYS[1], ARGV[1])
         return added`,
        { keys: [key], arguments: [String(ttlSeconds), ...fields] }
      );
    },
    async hGet(key: string, field: string) {
      return lua.hash(key)?.[field] ?? null;
    },
    async hGetAll(key: string) {
      return lua.hash(key) ?? {};
    },
    async hDel(key: string, fields: string | string[]) {
      return lua.eval(`return redis.call('HDEL', KEYS[1], unpack(ARGV))`, {
        keys: [key],
        arguments: [fields].flat(),
      });
    },
  };
}
