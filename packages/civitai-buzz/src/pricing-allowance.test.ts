import { describe, expect, it } from 'vitest';
import { MONETIZATION_MIN_CREATOR_SCORE, minCreatorScoreForSale } from './paid-access';
import {
  EARLY_ACCESS_NOT_COUNTED,
  PRICING_SLOT_EXPLAINER,
  exceedsAllowance,
  formatPricingAllowance,
  isAlreadyPriced,
  monthlyPricingAllowance,
  pricingAllowanceMessage,
  pricingAllowanceState,
  pricingEligibility,
  pricingFloorMessage,
  pricingMonthStart,
} from './pricing-allowance';

describe('pricingEligibility', () => {
  it('is exclusive at the boundary in one direction only', () => {
    expect(pricingEligibility(MONETIZATION_MIN_CREATOR_SCORE - 1).eligible).toBe(false);
    expect(pricingEligibility(MONETIZATION_MIN_CREATOR_SCORE).eligible).toBe(true);
  });

  it('reports the shortfall, and zero once cleared', () => {
    expect(pricingEligibility(7500).shortfall).toBe(2500);
    expect(pricingEligibility(50000).shortfall).toBe(0);
  });

  // Fails closed: a creator whose score has never been computed must not be handed a priced editor.
  it.each([null, undefined, NaN, Infinity, -5])('reads %s as zero, not as eligible', (score) => {
    const state = pricingEligibility(score as number | null | undefined);
    expect(state.score).toBe(0);
    expect(state.eligible).toBe(false);
  });
});

describe('isAlreadyPriced — the one definition of the exemption', () => {
  it('counts a positive fee or a permanent gate', () => {
    expect(isAlreadyPriced({ licensingFee: 0.1 })).toBe(true);
    expect(isAlreadyPriced({ hasPermanentGate: true })).toBe(true);
    expect(isAlreadyPriced({ licensingFee: 5, hasPermanentGate: true })).toBe(true);
  });

  it('counts a gate even with no fee, and a fee even with no gate', () => {
    expect(isAlreadyPriced({ licensingFee: 0, hasPermanentGate: true })).toBe(true);
    expect(isAlreadyPriced({ licensingFee: 2, hasPermanentGate: false })).toBe(true);
  });

  it('does not count a zero, null, or absent fee', () => {
    expect(isAlreadyPriced({ licensingFee: 0 })).toBe(false);
    expect(isAlreadyPriced({ licensingFee: null })).toBe(false);
    expect(isAlreadyPriced({})).toBe(false);
  });
});

describe('monthlyPricingAllowance', () => {
  it('rises with the tier and is unlimited at gold', () => {
    expect(monthlyPricingAllowance('free')).toBe(3);
    expect(monthlyPricingAllowance('bronze')).toBe(10);
    expect(monthlyPricingAllowance('silver')).toBe(25);
    expect(monthlyPricingAllowance('gold')).toBe(Infinity);
    expect(monthlyPricingAllowance('founder')).toBe(monthlyPricingAllowance('bronze'));
  });

  it('falls back to the FREE allowance for an unknown or lapsed tier, never to zero', () => {
    expect(monthlyPricingAllowance(null)).toBe(3);
    expect(monthlyPricingAllowance(undefined)).toBe(3);
    expect(monthlyPricingAllowance('platinum')).toBe(3);
  });
});

describe('exceedsAllowance — one arithmetic for the single and bulk paths', () => {
  it('at count 1 is exactly "used >= limit"', () => {
    for (const used of [0, 1, 2, 3, 4]) expect(exceedsAllowance(used, 3)).toBe(used >= 3);
  });

  it('refuses a batch as a whole rather than half-applying it', () => {
    expect(exceedsAllowance(1, 3, 2)).toBe(false);
    expect(exceedsAllowance(1, 3, 3)).toBe(true);
  });

  it('never exceeds an unlimited allowance', () => {
    expect(exceedsAllowance(9999, Infinity, 9999)).toBe(false);
  });
});

describe('pricingMonthStart', () => {
  it('is the first instant of the current UTC month', () => {
    expect(pricingMonthStart(new Date('2026-08-21T13:00:00.000Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z'
    );
    expect(pricingMonthStart(new Date('2026-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  // A local-time month start would shift the boundary by the host's offset, so a creator's allowance
  // would reset at a different moment depending on which server answered.
  it('does not shift with the host timezone', () => {
    expect(pricingMonthStart(new Date('2026-08-01T00:30:00.000Z')).getUTCDate()).toBe(1);
    expect(pricingMonthStart(new Date('2026-08-31T23:30:00.000Z')).getUTCMonth()).toBe(7);
  });
});

describe('pricingAllowanceState', () => {
  it('reports remaining and atLimit for a limited tier', () => {
    expect(pricingAllowanceState({ used: 1, limit: 3 })).toMatchObject({
      remaining: 2,
      atLimit: false,
      unlimited: false,
    });
    expect(pricingAllowanceState({ used: 3, limit: 3 })).toMatchObject({
      remaining: 0,
      atLimit: true,
    });
  });

  it('is never at the limit when unlimited', () => {
    expect(pricingAllowanceState({ used: 9999, limit: null })).toMatchObject({
      unlimited: true,
      remaining: Infinity,
      atLimit: false,
    });
  });

  it('is not at the limit for an exempt entity, however full the month', () => {
    expect(pricingAllowanceState({ used: 3, limit: 3, exempt: true }).atLimit).toBe(false);
  });
});

describe('formatPricingAllowance', () => {
  it('says the same thing everywhere it is rendered', () => {
    expect(formatPricingAllowance(pricingAllowanceState({ used: 1, limit: 3 }))).toBe(
      '1 of 3 versions priced this month'
    );
    expect(formatPricingAllowance(pricingAllowanceState({ used: 3, limit: 3 }))).toBe(
      '3 of 3 versions priced this month · limit reached'
    );
    expect(formatPricingAllowance(pricingAllowanceState({ used: 7, limit: null }))).toBe(
      '7 versions priced this month · unlimited'
    );
  });
});

describe('refusal messages', () => {
  // Asserted against the LITERAL, not against the constant the message interpolates — that version
  // stayed green for any value of the threshold, including 100.
  it('name the enforced numbers', () => {
    expect(MONETIZATION_MIN_CREATOR_SCORE).toBe(10000);
    expect(pricingFloorMessage()).toContain('10,000');
    expect(pricingAllowanceMessage(3, 3)).toContain('3 of 3');
  });

  // The two doors onto "may this creator charge" were separate constants that happened to agree.
  it('the sale floor defaults to the same score, with no override in play', () => {
    expect(minCreatorScoreForSale()).toBe(MONETIZATION_MIN_CREATOR_SCORE);
    expect(minCreatorScoreForSale({ minCreatorScore: 500 })).toBe(500);
  });

  it('names the creator their own score when it is known', () => {
    expect(pricingFloorMessage(2431)).toContain('2,431');
    expect(pricingFloorMessage()).not.toMatch(/Yours is/);
  });

  // The ledger is keyed on ModelVersion, so two versions of one model spend two. Saying "models"
  // reads as one per model and understates the cost of pricing a multi-version model.
  it('count model VERSIONS, not models', () => {
    expect(pricingAllowanceMessage(3, 3)).toContain('model versions');
    expect(formatPricingAllowance(pricingAllowanceState({ used: 1, limit: 3 }))).toContain(
      'versions'
    );
    expect(pricingAllowanceMessage(3, 3)).not.toMatch(/\d+ models\b/);
  });

  it('say priced, not monetized, wherever a slot is counted', () => {
    expect(pricingAllowanceMessage(3, 3)).toMatch(/priced 3 of 3/);
    expect(pricingAllowanceMessage(3, 3)).not.toMatch(/monetized/);
    expect(formatPricingAllowance(pricingAllowanceState({ used: 1, limit: 3 }))).toMatch(/priced/);
    expect(formatPricingAllowance(pricingAllowanceState({ used: 1, limit: 3 }))).not.toMatch(
      /monetized/
    );
    expect(pricingFloorMessage()).toMatch(/to monetize a model version/);
  });

  it('the cap refusal rules Early Access out and names both things that count', () => {
    const message = pricingAllowanceMessage(25, 25);
    expect(message).toMatch(/licensing fee/i);
    expect(message).toMatch(/permanent paid access/i);
    expect(message).toMatch(/Early Access/);
    expect(message).toMatch(/separate limit/);
    expect(PRICING_SLOT_EXPLAINER).toMatch(/Early Access/);
    expect(EARLY_ACCESS_NOT_COUNTED).toMatch(/separate limit/);
  });

  it('names the tier when the caller knows it', () => {
    expect(pricingAllowanceMessage(25, 25, 'Silver')).toContain('on Silver');
    expect(pricingAllowanceMessage(25, 25)).not.toContain('undefined');
  });

  it('both say an existing price is unaffected', () => {
    expect(pricingFloorMessage()).toMatch(/already set/);
    expect(pricingAllowanceMessage(3, 3)).toMatch(/already set/);
  });
});
