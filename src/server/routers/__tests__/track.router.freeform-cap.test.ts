import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Redis client comes from the canonical shared mock.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { trackRouter } from '../track.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const track = { action: vi.fn(), search: vi.fn(), view: vi.fn() };

const caller = () =>
  trackRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 1 },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false } as never,
    track: track as never,
  } as never);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code ?? 'UNKNOWN'
  );

const cancel = (pad: number) => ({
  type: 'Membership_Cancel' as const,
  details: { reason: 'r', from: 'f', note: 'x'.repeat(pad) },
});

describe('track router free-form payload cap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addAction refuses an action over the cap before the tracker sees it', async () => {
    expect(await codeOf(caller().addAction(cancel(64 * 1024)))).toBe('BAD_REQUEST');
    expect(track.action).not.toHaveBeenCalled();
    // Positive control: the same action under the cap reaches the tracker.
    expect(await codeOf(caller().addAction(cancel(10)))).toBe('OK');
    expect(track.action).toHaveBeenCalledTimes(1);
  });

  it('trackSearch refuses filters over the cap before the tracker sees them', async () => {
    const search = (pad: number) => ({
      query: 'cat',
      index: 'models',
      filters: { note: 'x'.repeat(pad) },
    });
    expect(await codeOf(caller().trackSearch(search(64 * 1024)))).toBe('BAD_REQUEST');
    expect(track.search).not.toHaveBeenCalled();
    expect(await codeOf(caller().trackSearch(search(10)))).toBe('OK');
    expect(track.search).toHaveBeenCalledTimes(1);
  });
});
