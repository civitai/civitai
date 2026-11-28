import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getUserContentOverview,
  getUserContentOverviewPublic,
  getUserContentOverviewSfw,
  userImageVideoCountCache,
  userImageVideoCountPublicCache,
  userImageVideoCountSfwCache,
} from '~/server/redis/caches';

const USER = 7;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ['all', getUserContentOverview, userImageVideoCountCache],
  ['sfw', getUserContentOverviewSfw, userImageVideoCountSfwCache],
  ['public', getUserContentOverviewPublic, userImageVideoCountPublicCache],
] as const)('the %s profile overview', (_variant, read, countCache) => {
  it("reports the creator's song count", async () => {
    vi.spyOn(countCache, 'fetch').mockResolvedValue({
      [USER]: { id: USER, imageCount: 3, videoCount: 2, audioCount: 5 },
    });
    expect((await read(USER))[USER]).toMatchObject({ imageCount: 3, videoCount: 2, audioCount: 5 });
  });

  it('reads a count cached before songs were counted as 0 songs', async () => {
    // An entry written by the previous shape has no audioCount.
    vi.spyOn(countCache, 'fetch').mockResolvedValue({
      [USER]: { id: USER, imageCount: 3, videoCount: 2 } as never,
    });
    expect((await read(USER))[USER].audioCount).toBe(0);
  });
});
