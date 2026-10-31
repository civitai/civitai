import { createLuaRedis } from '../../../../src/server/utils/__tests__/redis-lua-harness';

// In-memory stand-in for the sys redis client: the hash, set and string commands the session registry and
// lineage records use, with per-field and per-key TTLs recorded rather than enforced. `eval` runs the script in
// real Lua over the same hashes and sets. Reset it between tests rather than replacing it: the session registry
// keeps the first client it is given.
export function makeSysRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  const hash = (k: string) => hashes.get(k) ?? (hashes.set(k, new Map()), hashes.get(k)!);
  return {
    hashes,
    sets,
    strings,
    ttls,
    reset() {
      for (const m of [hashes, sets, strings, ttls]) m.clear();
    },
    async eval(script: string, opts: { keys: string[]; arguments: string[] }) {
      const lua = createLuaRedis(Date.now());
      for (const k of opts.keys) {
        const hm = hashes.get(k);
        if (hm) lua.setHash(k, Object.fromEntries(hm));
        const sm = sets.get(k);
        if (sm) lua.setSet(k, [...sm]);
      }
      const result = await lua.eval(script, opts);
      for (const k of opts.keys) {
        const hm = lua.hash(k);
        if (hm) {
          hashes.set(k, new Map(Object.entries(hm)));
          for (const field of Object.keys(hm)) {
            const ms = lua.hpttl(k, field);
            if (ms > 0) ttls.set(`${k}|${field}`, Math.round(ms / 1000));
          }
        } else hashes.delete(k);
        const sm = lua.set(k);
        if (sm) sets.set(k, new Set(sm));
        else sets.delete(k);
        const ms = lua.pttl(k);
        if (ms > 0) ttls.set(k, Math.round(ms / 1000));
      }
      return result;
    },
    async hSet(key: string, field: string, value: string | number) {
      hash(key).set(field, String(value));
    },
    async hGet(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hDel(key: string, field: string) {
      hashes.get(key)?.delete(field);
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hLen(key: string) {
      return hashes.get(key)?.size ?? 0;
    },
    async hExpire(key: string, field: string, seconds: number) {
      ttls.set(`${key}|${field}`, seconds);
    },
    async sAdd(key: string, values: string[]) {
      const s = sets.get(key) ?? (sets.set(key, new Set()), sets.get(key)!);
      for (const v of values) s.add(v);
    },
    async sMembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async expire(key: string, seconds: number) {
      ttls.set(key, seconds);
    },
    async exists(key: string) {
      return hashes.has(key) || sets.has(key) || strings.has(key) ? 1 : 0;
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string) {
      strings.set(key, value);
    },
    async del(keys: string | string[]) {
      for (const k of [keys].flat()) {
        hashes.delete(k);
        sets.delete(k);
        strings.delete(k);
      }
    },
  };
}

export type SysRedisFake = ReturnType<typeof makeSysRedis>;
