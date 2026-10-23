import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const cf = vi.hoisted(() => ({ purged: [] as string[] }));
vi.mock('cloudflare', () => ({
  default: class {
    zones = {
      purgeCache: vi.fn(async (_zone: string, { files }: { files: string[] }) => {
        cf.purged.push(...files);
      }),
    };
  },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

// The client is built when the module loads, from these.
envMock.set({ CF_ZONE_ID: 'zone', CF_API_TOKEN: 'token' });
const { bustUserCreator } = await import('~/server/services/user-creator.service');
const { REDIS_KEYS } = await import('~/server/redis/client');

const USER = 4101;
const url = (input: string) => `/api/trpc/user.getCreator?input=${input}`;

/**
 * The URLs `edgeCacheIt` recorded, keyed as it records them: under the slugged tag
 * (`slugit('user-creator-Old_Name')` = 'user-creator-oldname'). Literal, so a change to how either
 * side spells the key shows up here as a URL left unpurged.
 */
const recorded: Record<string, string[]> = {
  [`user-creator-${USER}`]: [url('by-id')],
  'user-creator-oldname': [url('by-old-name')],
  'user-creator-newname': [url('by-new-name')],
};

beforeEach(() => {
  cf.purged = [];
  redisMock.redis.sMembers.mockImplementation(
    async (key: string) => recorded[key.slice(`${REDIS_KEYS.CACHES.EDGE_CACHED}:`.length)] ?? []
  );
  // The primary already holds the new name: the bust runs after the rename commits.
  dbMock.dbWrite.user.findMany.mockResolvedValue([{ username: 'New_Name' }] as never);
});

const purgedPaths = () => cf.purged.map((u) => u.replace('https://civitai.com', '')).sort();

describe('creator card edge purge', () => {
  it('a rename purges the responses cached by id, by the old username and by the new one', async () => {
    await bustUserCreator(USER, { usernames: ['Old_Name'], awaitPurge: true });
    expect(purgedPaths()).toEqual([url('by-id'), url('by-new-name'), url('by-old-name')].sort());
  });

  it('a failed username read still purges the responses cached by id', async () => {
    dbMock.dbWrite.user.findMany.mockRejectedValue(new Error('primary down'));
    await expect(bustUserCreator(USER, { awaitPurge: true })).resolves.toBeUndefined();
    expect(purgedPaths()).toEqual([url('by-id')]);
  });
});
