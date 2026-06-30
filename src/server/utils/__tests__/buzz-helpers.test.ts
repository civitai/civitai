import { describe, expect, it } from 'vitest';
import {
  getAllowedAccountTypes,
  getBlockAllowedAccountTypes,
  isPayoutEligibleBuzz,
  PAYOUT_ELIGIBLE_BUZZ_TYPES,
} from '~/server/utils/buzz-helpers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const features = (isGreen: boolean) => ({ isGreen } as unknown as FeatureAccess);

describe('getBlockAllowedAccountTypes — App Blocks currency parity', () => {
  it('SFW (green/blue, isGreen=true) → blue then green (blue-first)', () => {
    expect(getBlockAllowedAccountTypes(true)).toEqual(['blue', 'green']);
  });

  it('mature (.red, isGreen=false) → blue then yellow (blue-first)', () => {
    expect(getBlockAllowedAccountTypes(false)).toEqual(['blue', 'yellow']);
  });

  it('is blue-first in BOTH branches (orchestrator drains in array order)', () => {
    expect(getBlockAllowedAccountTypes(true)[0]).toBe('blue');
    expect(getBlockAllowedAccountTypes(false)[0]).toBe('blue');
  });

  it('matches on-site getAllowedAccountTypes(["blue"]) for the same maturity', () => {
    // The block helper must mirror the on-site generator's
    // resolveGenerationCurrencies fallback (getAllowedAccountTypes(features, ['blue'])).
    expect(getBlockAllowedAccountTypes(true)).toEqual(
      getAllowedAccountTypes(features(true), ['blue'])
    );
    expect(getBlockAllowedAccountTypes(false)).toEqual(
      getAllowedAccountTypes(features(false), ['blue'])
    );
  });

  it('never includes red (disabled) or duplicate currencies', () => {
    for (const isGreen of [true, false]) {
      const types = getBlockAllowedAccountTypes(isGreen);
      expect(types).not.toContain('red');
      expect(new Set(types).size).toBe(types.length);
    }
  });
});

describe('isPayoutEligibleBuzz — payout-safety allowlist', () => {
  it('yellow (purchased/earned) is payout-eligible', () => {
    expect(isPayoutEligibleBuzz('yellow')).toBe(true);
  });

  it('blue (free generation Buzz) is EXCLUDED', () => {
    expect(isPayoutEligibleBuzz('blue')).toBe(false);
  });

  it('green (includes free/granted daily Buzz) is EXCLUDED', () => {
    expect(isPayoutEligibleBuzz('green')).toBe(false);
  });

  it('red (disabled) is EXCLUDED', () => {
    expect(isPayoutEligibleBuzz('red')).toBe(false);
  });

  it('null / undefined / unknown types are EXCLUDED (fail-closed)', () => {
    expect(isPayoutEligibleBuzz(null)).toBe(false);
    expect(isPayoutEligibleBuzz(undefined)).toBe(false);
    expect(isPayoutEligibleBuzz('bogus')).toBe(false);
    expect(isPayoutEligibleBuzz('')).toBe(false);
  });

  it('the allowlist contains ONLY yellow (conservative default — guards against silent widening)', () => {
    expect([...PAYOUT_ELIGIBLE_BUZZ_TYPES]).toEqual(['yellow']);
  });

  it('every currency a block can SPEND that is free/granted is non-payout-eligible', () => {
    // Cross-check the parity widening against the payout gate: of the
    // currencies a block can spend (blue/green/yellow), exactly the
    // free/granted ones (blue, green) are excluded from payout.
    const sfwSpendable = getBlockAllowedAccountTypes(true); // ['blue','green']
    const matureSpendable = getBlockAllowedAccountTypes(false); // ['blue','yellow']
    // SFW block: NOTHING it spends is payout-eligible (free-Buzz farming impossible).
    expect(sfwSpendable.some(isPayoutEligibleBuzz)).toBe(false);
    // Mature block: only the domain currency (yellow) is eligible; blue is not.
    expect(matureSpendable.filter(isPayoutEligibleBuzz)).toEqual(['yellow']);
  });
});
