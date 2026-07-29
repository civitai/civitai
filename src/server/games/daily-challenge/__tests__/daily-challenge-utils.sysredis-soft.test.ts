import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-7 sysRedis soft-dependency (Group A) — daily-challenge.utils.getChallengeConfig.
 *
 * getChallengeConfig reads the packed challenge-config blob (sysRedis.packed.get)
 * and merges it over the in-code defaults. It was already try/catch fail-open
 * (console.error → fall through to defaults) but PARKED ~11min on a silent
 * half-open. STEP 7 adds `withSysReadDeadline` and the structured
 * logSysRedisFailOpen('read-degraded', 'getChallengeConfig', ...) on the
 * fail-open branch.
 *
 * The SLOW test is fail-on-revert: the underlying packed.get NEVER settles, so
 * removing the wrap would hang the call → the test would TIME OUT.
 */

const { packedGet, packedSet, mockWithSysReadDeadline, mockLogSysRedisFailOpen, findUnique } =
  vi.hoisted(() => ({
    packedGet: vi.fn(),
    packedSet: vi.fn(async () => undefined),
    mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    mockLogSysRedisFailOpen: vi.fn(),
    findUnique: vi.fn(async () => null),
  }));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { packed: { get: packedGet, set: packedSet } },
  REDIS_SYS_KEYS: { DAILY_CHALLENGE: { CONFIG: 'daily-challenge:config' } },
  withSysReadDeadline: mockWithSysReadDeadline,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
// findUnique → null so fetchJudgingConfigFromDb returns null (no secondary packed.set).
vi.mock('~/server/db/client', () => ({ dbRead: { challengeJudge: { findUnique } }, dbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: vi.fn(async () => ({})) }));

import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  packedGet.mockResolvedValue({}); // empty redis config → pure defaults
  findUnique.mockResolvedValue(null);
});

describe('getChallengeConfig — sysRedis packed.get (fail-open to defaults, park-bounded)', () => {
  it('happy path: merges redis config over defaults; read wrapped once; no fail-open log', async () => {
    packedGet.mockResolvedValue({ challengeType: 'world-morph' });
    const config = await getChallengeConfig();
    expect(config.challengeType).toBe('world-morph');
    // Falls back to a default for an unset field.
    expect(config.reviewAmount).toBeDefined();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: packed.get throws → fail-open to defaults; logSysRedisFailOpen fired', async () => {
    packedGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const config = await getChallengeConfig();
    // Still returns the in-code defaults.
    expect(config.reviewAmount).toBeDefined();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getChallengeConfig',
      expect.any(Error)
    );
  });

  it('SLOW/half-open: packed.get NEVER settles + deadline REJECTS → defaults (fail-on-revert)', async () => {
    packedGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    const config = await getChallengeConfig();
    expect(config.reviewAmount).toBeDefined();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getChallengeConfig',
      expect.any(Error)
    );
  });
});
