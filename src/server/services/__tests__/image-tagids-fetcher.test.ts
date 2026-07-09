import { describe, it, expect, vi } from 'vitest';
import { CacheService } from '../../../../event-engine-common/services/cache';
import type {
  IRedisClient,
  IDbClient,
  IClickhouseClient,
} from '../../../../event-engine-common/types/package-stubs';

// These tests pin the injection contract that the civitai feed relies on:
//  - When civitai injects its own warm `tagIdsForImagesCache` as the 5th
//    positional constructor arg, `CacheService.fetchImageTagIds` MUST route
//    through that fetcher (and never touch redis/pg/ch).
//  - When no fetcher is injected, it falls back to the uncached direct DB read
//    in `fetchImageTagIdsFromDb`, which applies the WD14/Rekognition filter.
//
// Stubs are intentionally minimal: on the injected path redis/pg/ch are never
// used, and on the fallback path only `pg.query` is exercised.

const noopRedis = {} as unknown as IRedisClient;
const noopCh = {} as unknown as IClickhouseClient;

describe('CacheService.fetchImageTagIds — injected fetcher', () => {
  it('routes through the injected fetcher and returns its result', async () => {
    const injectedFetcher = vi.fn(async (ids: number[]) => ({
      [ids[0]]: { imageId: ids[0], tags: [10, 20] },
    }));
    const fakePg = { query: vi.fn() } as unknown as IDbClient;

    const svc = new CacheService(noopRedis, fakePg, noopCh, undefined, injectedFetcher);

    const result = await svc.fetchImageTagIds([5]);

    expect(result).toEqual({ 5: { imageId: 5, tags: [10, 20] } });
    expect(injectedFetcher).toHaveBeenCalledTimes(1);
    expect(injectedFetcher).toHaveBeenCalledWith([5]);
    // The injected path must not touch the DB.
    expect((fakePg as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty id list without calling the fetcher', async () => {
    const injectedFetcher = vi.fn(async (ids: number[]) => ({
      [ids[0]]: { imageId: ids[0], tags: [1] },
    }));
    const fakePg = { query: vi.fn() } as unknown as IDbClient;

    const svc = new CacheService(noopRedis, fakePg, noopCh, undefined, injectedFetcher);

    const result = await svc.fetchImageTagIds([]);

    expect(result).toEqual({});
    expect(injectedFetcher).not.toHaveBeenCalled();
  });
});

describe('CacheService.fetchImageTagIds — DB fallback (no injected fetcher)', () => {
  it('applies the WD14/Rekognition filter: drops a plain Rekognition tag, keeps allowlist + Moderation', async () => {
    // Image 1 has a WD14 tag, so its Rekognition tags get filtered:
    //  - tag 100 (WD14)         -> kept (it's the WD14 tag itself)
    //  - tag 200 (Rekognition, type 'Tag', name 'landscape')  -> DROPPED
    //  - tag 300 (Rekognition, type 'Tag', name 'anime')      -> KEPT (allowlist)
    //  - tag 400 (Rekognition, type 'Moderation', name 'gore') -> KEPT (Moderation)
    const imageTagRows = [
      { imageId: 1, tagId: 100, source: 'WD14' },
      { imageId: 1, tagId: 200, source: 'Rekognition' },
      { imageId: 1, tagId: 300, source: 'Rekognition' },
      { imageId: 1, tagId: 400, source: 'Rekognition' },
    ];
    const tagMetaRows = [
      { id: 100, name: 'cat', type: 'Tag' },
      { id: 200, name: 'landscape', type: 'Tag' },
      { id: 300, name: 'anime', type: 'Tag' }, // in ALWAYS_INCLUDE_TAGS
      { id: 400, name: 'gore', type: 'Moderation' },
    ];

    // CacheService wraps pg.query expecting a `{ rows: [...] }` shape.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: imageTagRows })
      .mockResolvedValueOnce({ rows: tagMetaRows });
    const fakePg = { query } as unknown as IDbClient;

    const svc = new CacheService(noopRedis, fakePg, noopCh);

    const result = await svc.fetchImageTagIds([1]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      1: { imageId: 1, tags: [100, 300, 400] },
    });
    // Plain Rekognition tag was filtered out.
    expect(result[1].tags).not.toContain(200);
  });

  it('keeps all Rekognition tags when the image has NO WD14 tag', async () => {
    const imageTagRows = [
      { imageId: 2, tagId: 500, source: 'Rekognition' },
      { imageId: 2, tagId: 600, source: 'Rekognition' },
    ];
    const tagMetaRows = [
      { id: 500, name: 'landscape', type: 'Tag' },
      { id: 600, name: 'sunset', type: 'Tag' },
    ];

    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: imageTagRows })
      .mockResolvedValueOnce({ rows: tagMetaRows });
    const fakePg = { query } as unknown as IDbClient;

    const svc = new CacheService(noopRedis, fakePg, noopCh);

    const result = await svc.fetchImageTagIds([2]);

    expect(result).toEqual({
      2: { imageId: 2, tags: [500, 600] },
    });
  });

  it('short-circuits on an empty id list without querying the DB', async () => {
    const query = vi.fn();
    const fakePg = { query } as unknown as IDbClient;

    const svc = new CacheService(noopRedis, fakePg, noopCh);

    const result = await svc.fetchImageTagIds([]);

    expect(result).toEqual({});
    expect(query).not.toHaveBeenCalled();
  });
});
