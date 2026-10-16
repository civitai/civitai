import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  BLOCK_UPLOAD_APP_RATE_LIMIT_MAX,
  BLOCK_UPLOAD_APP_RATE_LIMIT_WINDOW_SECONDS,
  checkBlockUploadAppRateLimit,
} from '../block-catalog-rate-limit';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockRedis = redisMock.redis;

/**
 * The upload bucket `blocks.persistAppUploadImage` charges — the only one it charges: one
 * allowance per app, across its viewers and installs. The key is asserted literally.
 */
describe('checkBlockUploadAppRateLimit', () => {
  const APP_KEY = 'blocks:token-rate-limit:upload-app:appblk_test';

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_UPLOAD_APP_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('keys on the app alone, in its own `:upload-app:` sub-namespace, one token per upload', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockUploadAppRateLimit('appblk_test');
    expect(mockRedis.incrBy.mock.calls).toEqual([[APP_KEY, 1]]);
    expect(mockRedis.expire.mock.calls).toEqual([[APP_KEY, 300]]);
  });

  it('two different apps get different keys', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockUploadAppRateLimit('appblk_alpha');
    await checkBlockUploadAppRateLimit('appblk_beta');
    expect(mockRedis.incrBy.mock.calls.map((c) => c[0])).toEqual([
      'blocks:token-rate-limit:upload-app:appblk_alpha',
      'blocks:token-rate-limit:upload-app:appblk_beta',
    ]);
  });

  it('allows exactly 600 in a window and refuses the next one with the live TTL', async () => {
    expect(BLOCK_UPLOAD_APP_RATE_LIMIT_MAX).toBe(600);
    expect(BLOCK_UPLOAD_APP_RATE_LIMIT_WINDOW_SECONDS).toBe(300);

    mockRedis.incrBy.mockResolvedValue(600);
    await expect(checkBlockUploadAppRateLimit('appblk_test')).resolves.toEqual({ allowed: true });

    mockRedis.incrBy.mockResolvedValue(601);
    mockRedis.ttl.mockResolvedValue(177);
    await expect(checkBlockUploadAppRateLimit('appblk_test')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 177,
    });
  });

  it('FAILS OPEN on a redis error, like every sibling limiter', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockUploadAppRateLimit('appblk_test')).resolves.toEqual({ allowed: true });
  });
});
