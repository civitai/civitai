import { describe, it, expect, vi } from 'vitest';
import { deepStringProxy } from './test-utils';

// Block heavy module-load side effects from new-order.service.ts's import chain.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/client', () => ({
  redis: {},
  sysRedis: {},
  REDIS_KEYS: deepStringProxy('rk'),
  REDIS_SYS_KEYS: deepStringProxy('rsk'),
}));

// Import AFTER mocks so the module-load chain uses stubbed clients.
import {
  calculateFervor,
  calculateVoteWeight,
} from '~/server/services/games/new-order.service';

describe('new-order pure functions', () => {
  describe('calculateVoteWeight', () => {
    it('returns 1.0 for new Knight (level 20, no smites)', () => {
      expect(calculateVoteWeight({ level: 20, smites: 0 })).toBe(1);
    });

    it('returns 2.0 for max Knight (level 80, no smites)', () => {
      expect(calculateVoteWeight({ level: 80, smites: 0 })).toBe(2);
    });

    it('returns 0.0 for new Knight with 6 smites', () => {
      // 1 + 0/60 - 6/6 = 0
      expect(calculateVoteWeight({ level: 20, smites: 6 })).toBe(0);
    });

    it('returns 1.0 for max Knight with 6 smites (level bonus cancels smite penalty)', () => {
      // 1 + (80-20)/60 - 6/6 = 1 + 1 - 1 = 1
      expect(calculateVoteWeight({ level: 80, smites: 6 })).toBe(1);
    });

    it('rounds to 2 decimal places', () => {
      // 1 + (35-20)/60 - 0 = 1.25
      expect(calculateVoteWeight({ level: 35, smites: 0 })).toBe(1.25);
    });

    it('handles partial smite at mid level', () => {
      // 1 + (50-20)/60 - 2/6 = 1 + 0.5 - 0.333... = 1.166...
      const w = calculateVoteWeight({ level: 50, smites: 2 });
      expect(w).toBeCloseTo(1.17, 2);
    });

    it('can return values above 1.0 even with smites if level high enough', () => {
      // 1 + (60-20)/60 - 1/6 = 1 + 0.666 - 0.166 = 1.5
      expect(calculateVoteWeight({ level: 60, smites: 1 })).toBe(1.5);
    });

    it('documents current behavior: returns negative below level 20 with heavy smites (callers should not pass <20)', () => {
      // level=10, smites=6: 1 + (10-20)/60 - 6/6 = 1 - 0.166… - 1 = -0.166…
      const w = calculateVoteWeight({ level: 10, smites: 6 });
      expect(w).toBeLessThan(0);
    });
  });

  describe('calculateFervor', () => {
    it('returns 0 when no judgments', () => {
      expect(calculateFervor({ correctJudgments: 0, allJudgments: 0 })).toBe(0);
    });

    it('returns 0 when correctJudgments is 0', () => {
      expect(calculateFervor({ correctJudgments: 0, allJudgments: 100 })).toBe(0);
    });

    it('uses 100% accuracy multiplier when all correct', () => {
      // 50 * 100 * 1.0 = 5000
      expect(calculateFervor({ correctJudgments: 50, allJudgments: 50 })).toBe(5000);
    });

    it('penalizes spammer with 20% accuracy', () => {
      // 1000 * 100 * 0.2 = 20000
      expect(calculateFervor({ correctJudgments: 1000, allJudgments: 5000 })).toBe(20000);
    });

    it('rewards 80% accuracy', () => {
      // 400 * 100 * 0.8 = 32000
      expect(calculateFervor({ correctJudgments: 400, allJudgments: 500 })).toBe(32000);
    });

    it('floors accuracy multiplier at 0.1 (prevents zero-out for very low accuracy)', () => {
      // accuracyRatio = 1/100 = 0.01, but floored at 0.1
      // 1 * 100 * 0.1 = 10
      expect(calculateFervor({ correctJudgments: 1, allJudgments: 100 })).toBe(10);
    });

    it('applies 0.1 floor only when accuracy is below 0.1', () => {
      // accuracyRatio = 10/100 = 0.1, floor doesn't change result
      // 10 * 100 * 0.1 = 100
      expect(calculateFervor({ correctJudgments: 10, allJudgments: 100 })).toBe(100);
    });

    it('floors to integer', () => {
      // accuracyRatio = 1/3 = 0.333…
      // 1 * 100 * 0.333… = 33.33… → floor to 33
      expect(calculateFervor({ correctJudgments: 1, allJudgments: 3 })).toBe(33);
    });
  });
});
