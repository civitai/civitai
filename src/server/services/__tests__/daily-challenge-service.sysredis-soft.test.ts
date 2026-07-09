import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-7 sysRedis soft-dependency (Group A) — daily-challenge.service.getCustomChallenge.
 *
 * getCustomChallenge is a RAW read (sysRedis.get, no try/catch) feeding the
 * still-live getCurrentDailyChallenge query. STEP 7 wraps it in try/catch +
 * withSysReadDeadline and fails OPEN to `null` ("no custom challenge" → the
 * regular challenge is shown). A sysRedis outage shouldn't 500 the challenge
 * view; and the awaited get would otherwise park ~11min on a silent half-open.
 *
 * The SLOW test is fail-on-revert: the underlying get NEVER settles, so removing
 * the wrap would hang the call → the test would TIME OUT.
 */

const { get, mockWithSysReadDeadline, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  get: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { get },
  REDIS_SYS_KEYS: { GENERATION: { CUSTOM_CHALLENGE: 'generation:custom-challenge' } },
  withSysReadDeadline: mockWithSysReadDeadline,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));
// Heavy sibling modules pulled in by the service's import graph — stub so the
// import doesn't pull DB / article service.
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getCurrentChallenge: vi.fn(),
  dailyChallengeConfig: {},
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({ getChallengeById: vi.fn() }));
vi.mock('~/server/services/article.service', () => ({ getArticles: vi.fn() }));

import { getCustomChallenge } from '~/server/services/daily-challenge.service';

const VALID = JSON.stringify({
  articleId: 1,
  endsAtDate: '2999-01-01',
  collectionId: 2,
  title: 'Custom',
  invitation: 'Join',
  coverUrl: 'guid',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  get.mockResolvedValue(VALID);
});

describe('getCustomChallenge — sysRedis get (RAW → fail-open null, park-bounded)', () => {
  it('happy path: parses + returns the challenge; read wrapped once; no fail-open log', async () => {
    const result = await getCustomChallenge();
    expect(result?.title).toBe('Custom');
    expect(result?.collectionId).toBe(2);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('unset key (get → null): returns null (behavior preserved), no fail-open log', async () => {
    get.mockResolvedValue(null);
    await expect(getCustomChallenge()).resolves.toBeNull();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: get throws → fail-open to null; logSysRedisFailOpen fired', async () => {
    get.mockRejectedValue(new Error('sysRedis connection is down'));
    await expect(getCustomChallenge()).resolves.toBeNull();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getCustomChallenge',
      expect.any(Error)
    );
  });

  it('SLOW/half-open: get NEVER settles + deadline REJECTS → null (fail-on-revert)', async () => {
    get.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    await expect(getCustomChallenge()).resolves.toBeNull();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getCustomChallenge',
      expect.any(Error)
    );
  });
});
