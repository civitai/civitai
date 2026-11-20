import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  userModelCountCache,
  userModelCountPublicCache,
  userModelCountSfwCache,
} from '~/server/redis/caches';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('userModelCountCache.refresh', () => {
  it('refreshes the sfw and public counts the profile Models tab reads on .com', async () => {
    const sfw = vi.spyOn(userModelCountSfwCache, 'refresh').mockResolvedValue();
    const pub = vi.spyOn(userModelCountPublicCache, 'refresh').mockResolvedValue();

    await userModelCountCache.refresh(7);

    expect(sfw).toHaveBeenCalledWith(7);
    expect(pub).toHaveBeenCalledWith(7);
  });
});
