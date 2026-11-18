import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '../client';
import { bustEventEngineProfilePictures } from '../event-engine-caches';

const eventEngine = (path: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../apps/event-engine/src/common/caches/${path}`, import.meta.url)
    ),
    'utf8'
  );

describe('the event-engine profile-picture bust', () => {
  it("names the event engine's cache key", () => {
    expect(eventEngine('imageData.cache.ts')).toContain(
      `redisKey: '${REDIS_KEYS.CACHES.EVENT_ENGINE_PROFILE_PICTURES}'`
    );
  });

  it('writes the debounce marker the event engine reads as a miss, with a short expiry', async () => {
    expect(eventEngine('base.ts')).toContain("cacheResult.debounce === '1'");
    const hSet = vi.fn(async () => 1);
    const expire = vi.fn(async () => true);

    await bustEventEngineProfilePictures({ hSet, expire }, [7, 8, 7]);

    expect(hSet.mock.calls.map(([key]) => key)).toEqual([
      'user:profilePicture:v3:7',
      'user:profilePicture:v3:8',
    ]);
    expect(hSet).toHaveBeenCalledWith('user:profilePicture:v3:7', {
      debounce: '1',
      cachedAt: expect.any(String),
    });
    expect(expire).toHaveBeenCalledWith('user:profilePicture:v3:8', 10);
  });
});
