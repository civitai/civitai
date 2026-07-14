import { describe, it, expect } from 'vitest';
import {
  CHALLENGE_JOB_CONCURRENCY,
  CHALLENGE_JOB_BATCH_SIZE,
  CHALLENGE_REVIEW_BUZZ_ESTIMATE,
} from '~/shared/constants/challenge.constants';

describe('challenge job constants', () => {
  it('caps concurrency conservatively', () => {
    expect(CHALLENGE_JOB_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(CHALLENGE_JOB_CONCURRENCY).toBeLessThanOrEqual(10);
  });
  it('bounds per-run batch size', () => {
    expect(CHALLENGE_JOB_BATCH_SIZE).toBeGreaterThanOrEqual(50);
  });
  it('exposes a positive per-review buzz estimate for metrics', () => {
    expect(CHALLENGE_REVIEW_BUZZ_ESTIMATE).toBeGreaterThan(0);
  });
});
