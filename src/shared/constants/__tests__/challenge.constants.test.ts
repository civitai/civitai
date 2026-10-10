import { describe, it, expect } from 'vitest';
import {
  CHALLENGE_JOB_CONCURRENCY,
  CHALLENGE_JOB_BATCH_SIZE,
} from '~/shared/constants/challenge.constants';

describe('challenge job constants', () => {
  it('caps concurrency conservatively', () => {
    expect(CHALLENGE_JOB_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(CHALLENGE_JOB_CONCURRENCY).toBeLessThanOrEqual(10);
  });
  it('bounds per-run batch size', () => {
    expect(CHALLENGE_JOB_BATCH_SIZE).toBeGreaterThanOrEqual(50);
  });
});

describe('describeActiveLimitsByTier', () => {
  it('states every tier limit, merging tiers that share one', async () => {
    const { describeActiveLimitsByTier } = await import('~/shared/constants/challenge.constants');

    expect(describeActiveLimitsByTier()).toBe('Free 1, Founder and Bronze 2, Silver 3, Gold 5');
  });
});
