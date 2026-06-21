import { describe, it, expect } from 'vitest';
import { parseReadinessNonCritical } from '../non-critical';

// parseReadinessNonCritical validates the READINESS_NONCRITICAL_CHECKS env list down to real
// check names. The whole point is a typo must suppress NOTHING (never accidentally mark a
// real check non-critical), and the default (empty/undefined) must preserve today's behavior.
const VALID = ['write', 'read', 'pgWrite', 'pgRead', 'searchMetrics', 'redis', 'sysRedis', 'clickhouse'] as const;

describe('parseReadinessNonCritical', () => {
  it('returns [] for undefined (default → readiness uses the same fatal-set as /api/health)', () => {
    expect(parseReadinessNonCritical(undefined, VALID)).toEqual([]);
  });

  it('returns [] for an empty list', () => {
    expect(parseReadinessNonCritical([], VALID)).toEqual([]);
  });

  it('keeps a valid check name (the intended prod value)', () => {
    expect(parseReadinessNonCritical(['redis'], VALID)).toEqual(['redis']);
  });

  it('keeps multiple valid names in input order', () => {
    expect(parseReadinessNonCritical(['redis', 'searchMetrics'], VALID)).toEqual([
      'redis',
      'searchMetrics',
    ]);
  });

  it('DROPS unknown names — a typo suppresses nothing rather than the wrong check', () => {
    // 'rediss' (typo) and 'database' (not a check) must be ignored; only the real 'redis' stays.
    expect(parseReadinessNonCritical(['rediss', 'database', 'redis'], VALID)).toEqual(['redis']);
  });

  it('drops ALL names when none are valid (never falls back to suppressing everything)', () => {
    expect(parseReadinessNonCritical(['nope', 'bogus'], VALID)).toEqual([]);
  });

  it('trims surrounding whitespace from env-split values', () => {
    expect(parseReadinessNonCritical([' redis ', '\tsysRedis'], VALID)).toEqual([
      'redis',
      'sysRedis',
    ]);
  });

  it('dedupes repeated names', () => {
    expect(parseReadinessNonCritical(['redis', 'redis', 'redis'], VALID)).toEqual(['redis']);
  });
});
