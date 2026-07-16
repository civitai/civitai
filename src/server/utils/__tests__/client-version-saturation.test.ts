import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetCapabilityCacheForTests,
  isPhase1CapableClientVersion,
  PHASE1_CLIENT_VERSION,
  phase1CapableLabel,
} from '~/server/utils/client-version-saturation';

/**
 * The Phase-2 (superjson → devalue write-flip) saturation gate reads a counter
 * bucketed by `isPhase1CapableClientVersion`. The bucketing must be:
 *   - correct at the threshold (>= 5.0.2080 capable; the ambiguous 5.0.2079 and
 *     everything older NOT capable — the safe lower-bound direction),
 *   - conservative for missing / unknown / garbage versions (NOT capable),
 *   - low-cardinality (a boolean label), and
 *   - stable under memoization.
 */

describe('isPhase1CapableClientVersion', () => {
  beforeEach(() => __resetCapabilityCacheForTests());

  it('threshold constant is the first unambiguously-Phase-1 version', () => {
    expect(PHASE1_CLIENT_VERSION).toBe('5.0.2080');
  });

  it('the exact threshold version is capable', () => {
    expect(isPhase1CapableClientVersion('5.0.2080')).toBe(true);
  });

  it('deployed Phase-1 builds and anything newer are capable', () => {
    for (const v of ['5.0.2081', '5.0.2082', '5.0.2100', '5.1.0', '6.0.0']) {
      expect(isPhase1CapableClientVersion(v)).toBe(true);
    }
  });

  it('the ambiguous straddle version 5.0.2079 and older are NOT capable', () => {
    for (const v of ['5.0.2079', '5.0.2078', '5.0.2000', '5.0.0', '4.9.9', '0.0.1']) {
      expect(isPhase1CapableClientVersion(v)).toBe(false);
    }
  });

  it('missing / empty / unknown / garbage versions are NOT capable (conservative)', () => {
    for (const v of [undefined, null, '', 'unknown', 'not-a-version', 'v5', '5.0']) {
      expect(isPhase1CapableClientVersion(v as any)).toBe(false);
    }
  });

  it('is stable across repeated (memoized) calls', () => {
    expect(isPhase1CapableClientVersion('5.0.2081')).toBe(true);
    expect(isPhase1CapableClientVersion('5.0.2081')).toBe(true);
    expect(isPhase1CapableClientVersion('5.0.2079')).toBe(false);
    expect(isPhase1CapableClientVersion('5.0.2079')).toBe(false);
  });
});

describe('phase1CapableLabel', () => {
  beforeEach(() => __resetCapabilityCacheForTests());

  it('maps to a bounded string label', () => {
    expect(phase1CapableLabel('5.0.2081')).toBe('true');
    expect(phase1CapableLabel('5.0.2079')).toBe('false');
    expect(phase1CapableLabel(undefined)).toBe('false');
  });
});
