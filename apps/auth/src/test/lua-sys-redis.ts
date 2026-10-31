// The main app's real-Lua redis harness. Loaded by URL with its extension so the apps CI path filter, which
// matches this literal, lists the exact file.
type Harness = { createLuaRedis: (startMs: number) => LuaRedis };
export type LuaRedis = {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  hash: (key: string) => Record<string, string> | undefined;
  setHash: (key: string, fields: Record<string, string>) => void;
  set: (key: string) => string[] | undefined;
  setSet: (key: string, members: string[]) => void;
  pttl: (key: string) => number;
  hpttl: (key: string, field: string) => number;
  errors: unknown[];
};
export const { createLuaRedis } = (await import(
  /* @vite-ignore */ new URL(
    '../../../../src/server/utils/__tests__/redis-lua-harness.ts',
    import.meta.url
  ).href
)) as Harness;

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
