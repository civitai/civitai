import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PublicApiRateLimit from '~/server/utils/public-api-rate-limit';

const { mockCheckFixedWindow } = vi.hoisted(() => ({
  mockCheckFixedWindow: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/utils/public-api-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof PublicApiRateLimit>()),
  checkFixedWindow: mockCheckFixedWindow,
}));

import {
  APP_VISIT_RATE_LIMIT_MAX,
  APP_VISIT_RATE_LIMIT_WINDOW_SECONDS,
  appVisitRateLimitKey,
  checkAppVisitRateLimit,
} from '~/server/utils/app-visit-rate-limit';

const req = (ip: string) => ({ headers: { 'cf-connecting-ip': ip }, socket: {} } as never);

describe('checkAppVisitRateLimit', () => {
  beforeEach(() => {
    mockCheckFixedWindow.mockReset();
    mockCheckFixedWindow.mockResolvedValue({ allowed: true });
  });

  it('checks the USER bucket for a signed-in actor, with the limit and window', async () => {
    await checkAppVisitRateLimit({ req: req('203.0.113.5'), userId: 7 });
    expect(mockCheckFixedWindow).toHaveBeenCalledTimes(1);
    expect(mockCheckFixedWindow).toHaveBeenCalledWith(
      appVisitRateLimitKey(7, '203.0.113.5'),
      APP_VISIT_RATE_LIMIT_MAX,
      APP_VISIT_RATE_LIMIT_WINDOW_SECONDS
    );
    expect(mockCheckFixedWindow.mock.calls[0][0]).toContain(':user:7');
  });

  it('checks the IP bucket for an anonymous actor', async () => {
    await checkAppVisitRateLimit({ req: req('198.51.100.9'), userId: null });
    expect(mockCheckFixedWindow).toHaveBeenCalledWith(
      appVisitRateLimitKey(null, '198.51.100.9'),
      APP_VISIT_RATE_LIMIT_MAX,
      APP_VISIT_RATE_LIMIT_WINDOW_SECONDS
    );
    expect(mockCheckFixedWindow.mock.calls[0][0]).toContain(':ip:198.51.100.9');
  });

  it('returns the limiter verdict unchanged', async () => {
    mockCheckFixedWindow.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    await expect(checkAppVisitRateLimit({ req: req('203.0.113.5') })).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 12,
    });
  });

  it('keys a user id of 0 as a user, not an ip (`!= null`, not truthiness)', () => {
    expect(appVisitRateLimitKey(0, '203.0.113.5')).toContain(':user:0');
    expect(appVisitRateLimitKey(0, '203.0.113.5')).not.toBe(
      appVisitRateLimitKey(null, '203.0.113.5')
    );
  });
});
