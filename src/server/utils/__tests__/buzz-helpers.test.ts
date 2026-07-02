import { describe, expect, it } from 'vitest';
import {
  getAllowedAccountTypes,
  getBlockAllowedAccountTypes,
  isPayoutEligibleBuzz,
  orderBlockCurrencyTypes,
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

  it('green (paid/purchasable) is payout-eligible', () => {
    expect(isPayoutEligibleBuzz('green')).toBe(true);
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

  it('the allowlist is the PAID types green + yellow (free blue excluded — guards against silent widening)', () => {
    expect([...PAYOUT_ELIGIBLE_BUZZ_TYPES].sort()).toEqual(['green', 'yellow']);
  });

  it('of the currencies a block can SPEND, only the free type (blue) is excluded from payout', () => {
    // Cross-check the parity widening against the payout gate: blocks spend
    // blue/green/yellow; blue is the ONLY free type, so it is the only one
    // excluded — the paid domain currency (green on .com, yellow on .red) is
    // payout-eligible (a real, non-farmable spend).
    const sfwSpendable = getBlockAllowedAccountTypes(true); // ['blue','green']
    const matureSpendable = getBlockAllowedAccountTypes(false); // ['blue','yellow']
    // blue (free) is never payout-eligible in either branch.
    expect(isPayoutEligibleBuzz('blue')).toBe(false);
    // SFW block: the paid domain currency (green) is eligible; blue is not.
    expect(sfwSpendable.filter(isPayoutEligibleBuzz)).toEqual(['green']);
    // Mature block: the paid domain currency (yellow) is eligible; blue is not.
    expect(matureSpendable.filter(isPayoutEligibleBuzz)).toEqual(['yellow']);
  });
});

describe('orderBlockCurrencyTypes — preferred-first + domain clamp', () => {
  it('no pick → the allowed set UNCHANGED (byte-identical to Auto), both domains', () => {
    // SFW.
    expect(orderBlockCurrencyTypes(true, undefined)).toEqual({
      ordered: getBlockAllowedAccountTypes(true),
      disallowed: false,
    });
    expect(orderBlockCurrencyTypes(true, undefined).ordered).toEqual(['blue', 'green']);
    // Mature.
    expect(orderBlockCurrencyTypes(false, undefined)).toEqual({
      ordered: getBlockAllowedAccountTypes(false),
      disallowed: false,
    });
    expect(orderBlockCurrencyTypes(false, undefined).ordered).toEqual(['blue', 'yellow']);
  });

  it('allowed pick → moved to the FRONT with the rest as fallback (SFW green)', () => {
    // allowed ['blue','green'] + pick green → ['green','blue'].
    expect(orderBlockCurrencyTypes(true, 'green')).toEqual({
      ordered: ['green', 'blue'],
      disallowed: false,
    });
  });

  it('allowed pick → moved to the FRONT with the rest as fallback (mature yellow)', () => {
    // allowed ['blue','yellow'] + pick yellow → ['yellow','blue'].
    expect(orderBlockCurrencyTypes(false, 'yellow')).toEqual({
      ordered: ['yellow', 'blue'],
      disallowed: false,
    });
  });

  it('picking blue (already first) keeps blue-first + fallback intact', () => {
    expect(orderBlockCurrencyTypes(true, 'blue')).toEqual({
      ordered: ['blue', 'green'],
      disallowed: false,
    });
  });

  it('disallowed pick → flagged disallowed, allowed set returned UNCHANGED (no widening)', () => {
    // yellow is NOT spendable on a SFW block; green is NOT spendable on a mature block.
    const sfw = orderBlockCurrencyTypes(true, 'yellow');
    expect(sfw.disallowed).toBe(true);
    expect(sfw.ordered).toEqual(['blue', 'green']); // set never widened to include yellow
    const mature = orderBlockCurrencyTypes(false, 'green');
    expect(mature.disallowed).toBe(true);
    expect(mature.ordered).toEqual(['blue', 'yellow']); // never widened to include green
  });
});
