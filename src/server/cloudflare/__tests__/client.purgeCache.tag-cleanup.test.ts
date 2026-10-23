import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

const cf = vi.hoisted(() => ({ onPurge: (() => undefined) as (files: string[]) => void }));
vi.mock('cloudflare', () => ({
  default: class {
    zones = {
      purgeCache: vi.fn(async (_zone: string, { files }: { files: string[] }) => cf.onPurge(files)),
    };
  },
}));

// The client is built when the module loads, from these.
envMock.set({ CF_ZONE_ID: 'zone', CF_API_TOKEN: 'token' });
const { purgeCache } = await import('~/server/cloudflare/client');
const { REDIS_KEYS } = await import('~/server/redis/client');

const TAG = 'purge-test';
const SET = `${REDIS_KEYS.CACHES.EDGE_CACHED}:${TAG}`;

let lua = createLuaRedis(Date.now());
const run = (script: string, keys: string[], args: string[]) =>
  lua.eval(script, { keys, arguments: args });
redisMock.redis.eval.mockImplementation(
  (script: string, opts: { keys: string[]; arguments: string[] }) => lua.eval(script, opts)
);
redisMock.redis.sMembers.mockImplementation(async (key: string) => lua.set(key) ?? []);
redisMock.redis.sRem.mockImplementation(async (key: string, members: string | string[]) => {
  let removed = 0;
  for (const member of [members].flat())
    removed += Number(await run("return redis.call('SREM', KEYS[1], ARGV[1])", [key], [member]));
  return removed;
});
redisMock.redis.del.mockImplementation((key: string) =>
  run("return redis.call('DEL', KEYS[1])", [key], [])
);

beforeEach(() => {
  lua = createLuaRedis(Date.now());
  cf.onPurge = () => undefined;
});

describe('purgeCache', () => {
  it('keeps every recorded URL, so one cached again during the purge is still found next time', async () => {
    lua.setSet(SET, ['/api/trpc/a', '/api/trpc/b']);
    const purged: string[] = [];
    cf.onPurge = (files) => {
      purged.push(...files);
      lua.setSet(SET, [...(lua.set(SET) ?? []), '/api/trpc/late']);
    };

    await purgeCache({ tags: [TAG] });

    expect(purged.sort()).toEqual([
      'https://civitai.com/api/trpc/a',
      'https://civitai.com/api/trpc/b',
    ]);
    expect(lua.set(SET)?.sort()).toEqual(['/api/trpc/a', '/api/trpc/b', '/api/trpc/late']);
  });
});
