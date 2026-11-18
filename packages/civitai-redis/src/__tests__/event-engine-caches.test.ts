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
    const hSet = vi.fn(async (_key: string, _value: Record<string, string>) => 1);
    const expire = vi.fn(async (_key: string, _seconds: number) => true);

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

  it('uses the debounce time the event engine gives this cache', () => {
    expect(eventEngine('base.ts')).toContain('config.debounceTime ?? 10');
    expect(eventEngine('imageData.cache.ts')).not.toMatch(/debounceTime:/);
  });

  it('busts a large batch at most ten users at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const hSet = vi.fn(async (_key: string, _value: Record<string, string>) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return 1;
    });
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);

    await bustEventEngineProfilePictures({ hSet, expire: async () => true }, ids);

    expect(hSet).toHaveBeenCalledTimes(25);
    expect(peak).toBe(10);
  });
});
