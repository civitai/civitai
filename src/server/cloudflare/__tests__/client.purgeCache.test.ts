import { beforeEach, describe, expect, it, vi } from 'vitest';

// Proves the Cloudflare edge-cache purge is best-effort at the SOURCE.
// purgeCache now AWAITS each CF batch call (so its outcome is reflected in the
// promise the concurrency helper awaits) AND swallows + logs a failure so it
// never propagates to callers. Pre-fix the CF call was fire-and-forget: the
// task resolved before the CF request settled, so a 429 / timeout / auth
// rejection escaped as an unhandled promise rejection and no caller guard could
// observe it. This is the real proof of the fix — the service-level guard tests
// mock purgeCache wholesale and can't exercise this path.

const { mockCfPurge } = vi.hoisted(() => ({ mockCfPurge: vi.fn() }));

vi.mock('cloudflare', () => ({
  default: class {
    zones = { purgeCache: mockCfPurge };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('~/env/server', () => ({
  env: {
    CF_API_TOKEN: 'test-token',
    CF_ZONE_ID: 'test-zone',
    LOGGING: 'cloudflare', // enable createLogger so the failure log is observable
  },
}));

vi.mock('~/server/redis/client', () => ({
  redis: { sMembers: vi.fn(), del: vi.fn() },
  REDIS_KEYS: { CACHES: { EDGE_CACHED: 'edge-cached' } },
}));

import { purgeCache } from '~/server/cloudflare/client';

const URL = 'https://civitai.com/api/v1/model-versions/by-hash/ABC123';

describe('purgeCache — best-effort Cloudflare purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits the CF call and resolves on success', async () => {
    mockCfPurge.mockResolvedValue({ success: true });

    await expect(purgeCache({ urls: [URL] })).resolves.toBeUndefined();

    expect(mockCfPurge).toHaveBeenCalledTimes(1);
    expect(mockCfPurge).toHaveBeenCalledWith('test-zone', { files: [URL] });
  });

  it('swallows a CF rejection (429/timeout/auth), logs it, and does NOT propagate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockCfPurge.mockRejectedValue(new Error('429 Too Many Requests'));

    // Must RESOLVE (swallow) — pre-fix this leaked an unhandled rejection.
    await expect(purgeCache({ urls: [URL] })).resolves.toBeUndefined();

    expect(mockCfPurge).toHaveBeenCalledTimes(1);
    // Failure is observed (logged), not silently orphaned.
    expect(logSpy).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to purge',
      1,
      'URLs from Cloudflare',
      expect.any(Error)
    );

    logSpy.mockRestore();
  });
});
