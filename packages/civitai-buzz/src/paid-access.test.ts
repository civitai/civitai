import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  buildModelVersionTerms,
  generationOpenToNonBuyers,
  generationPrice,
  generationTrialLimit,
  grantsGeneration,
  isFreeGeneration,
  isPaidAccessActive,
  isTimedGateActive,
  paidGenerationGrant,
  type ModelVersionTerms,
} from './paid-access';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const PAST = new Date('2026-07-27T00:00:00.000Z');
const FUTURE = new Date('2026-07-29T00:00:00.000Z');

describe('isPaidAccessActive / isTimedGateActive — the endsAt boundary', () => {
  it('permanent gate (endsAt null): active, but NOT timed-active', () => {
    expect(isPaidAccessActive({ endsAt: null }, NOW)).toBe(true);
    expect(isTimedGateActive({ endsAt: null }, NOW)).toBe(false);
  });
  it('future window: both active and timed-active', () => {
    expect(isPaidAccessActive({ endsAt: FUTURE }, NOW)).toBe(true);
    expect(isTimedGateActive({ endsAt: FUTURE }, NOW)).toBe(true);
  });
  it('past window (tombstone): neither', () => {
    expect(isPaidAccessActive({ endsAt: PAST }, NOW)).toBe(false);
    expect(isTimedGateActive({ endsAt: PAST }, NOW)).toBe(false);
  });
  it('endsAt exactly now is expired (strict >)', () => {
    expect(isPaidAccessActive({ endsAt: NOW }, NOW)).toBe(false);
    expect(isTimedGateActive({ endsAt: NOW }, NOW)).toBe(false);
  });
});

describe('generation terms predicates', () => {
  const free: ModelVersionTerms = { generation: { free: true } };
  const bundled: ModelVersionTerms = { download: { price: 500 } }; // no generation key = must buy
  const paidGen: ModelVersionTerms = { download: { price: 500 }, generation: { price: 200, trialLimit: 5 } };
  const paidGenNoTrial: ModelVersionTerms = { generation: { price: 200, trialLimit: 0 } };
  const paidGenAbsentTrial: ModelVersionTerms = { generation: { price: 200 } };

  it('isFreeGeneration only for { free: true }', () => {
    expect(isFreeGeneration(free)).toBe(true);
    expect(isFreeGeneration(bundled)).toBe(false);
    expect(isFreeGeneration(paidGen)).toBe(false);
  });

  it('paidGenerationGrant: the paid tier, or undefined for free/bundled', () => {
    expect(paidGenerationGrant(paidGen)).toEqual({ price: 200, trialLimit: 5 });
    expect(paidGenerationGrant(free)).toBeUndefined();
    expect(paidGenerationGrant(bundled)).toBeUndefined();
  });

  it('generationTrialLimit: explicit value, 0, or the default for an absent trialLimit', () => {
    expect(generationTrialLimit(paidGen)).toBe(5);
    expect(generationTrialLimit(paidGenNoTrial)).toBe(0);
    expect(generationTrialLimit(paidGenAbsentTrial)).toBe(DEFAULT_GENERATION_TRIAL_LIMIT);
    expect(generationTrialLimit(bundled)).toBe(0); // no paid gen tier
    expect(generationTrialLimit(free)).toBe(0); // free is not a "trial"
  });

  it('generationOpenToNonBuyers: free OR a positive trial limit', () => {
    expect(generationOpenToNonBuyers(free)).toBe(true);
    expect(generationOpenToNonBuyers(paidGen)).toBe(true); // trialLimit 5
    expect(generationOpenToNonBuyers(paidGenAbsentTrial)).toBe(true); // defaults to 10
    expect(generationOpenToNonBuyers(paidGenNoTrial)).toBe(false); // trialLimit 0
    expect(generationOpenToNonBuyers(bundled)).toBe(false); // must buy
  });
});

describe('generationPrice — effective generation-only purchase price', () => {
  it('uses the generation tier price when set', () => {
    expect(generationPrice({ download: { price: 500 }, generation: { price: 200 } })).toBe(200);
  });
  it('falls back to the download price when the generation grant omits price', () => {
    expect(generationPrice({ download: { price: 500 }, generation: { trialLimit: 5 } })).toBe(500);
  });
  it('undefined when there is no paid generation tier (free or bundled)', () => {
    expect(generationPrice({ generation: { free: true } })).toBeUndefined();
    expect(generationPrice({ download: { price: 500 } })).toBeUndefined();
  });
});

describe('grantsGeneration — the full access decision', () => {
  const bundled: ModelVersionTerms = { download: { price: 500 } };
  const trial: ModelVersionTerms = { download: { price: 500 }, generation: { price: 200, trialLimit: 5 } };
  const free: ModelVersionTerms = { generation: { free: true } };

  it('owner/mod always may generate, even on a bundled must-buy gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: true, hasBought: false })).toBe(true);
  });
  it('a buyer may generate on a bundled gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: false, hasBought: true })).toBe(true);
  });
  it('a non-owner non-buyer is BLOCKED on a bundled must-buy gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: false, hasBought: false })).toBe(false);
  });
  it('a non-owner non-buyer may generate when the gate offers a trial', () => {
    expect(grantsGeneration(trial, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });
  it('free generation is open to everyone', () => {
    expect(grantsGeneration(free, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });
});

describe('buildModelVersionTerms — the three generation grants', () => {
  it('bundles generation with the download when no generation price is given', () => {
    expect(buildModelVersionTerms({ accessPrice: 500, freePreviewGenerations: 10 })).toEqual({
      download: { price: 500 },
      generation: { trialLimit: 10 },
    });
  });

  it('writes a cheaper generation-only tier when a price is given', () => {
    expect(
      buildModelVersionTerms({ accessPrice: 500, generationPrice: 200, freePreviewGenerations: 10 })
    ).toEqual({ download: { price: 500 }, generation: { price: 200, trialLimit: 10 } });
  });

  // The point of the free grant: gate the download, leave generation open, earn per generation via a
  // licensing fee instead. It carries no price and no trial limit — there is nothing to sample toward.
  it('writes a free generation grant, dropping price and trial limit', () => {
    const terms = buildModelVersionTerms({
      accessPrice: 500,
      generationPrice: 200,
      freePreviewGenerations: 1000,
      freeGeneration: true,
    });
    expect(terms).toEqual({ download: { price: 500 }, generation: { free: true } });
    expect(isFreeGeneration(terms)).toBe(true);
    expect(paidGenerationGrant(terms)).toBeUndefined();
    expect(generationPrice(terms)).toBeUndefined();
    expect(grantsGeneration(terms, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });

  // A gen-only version has no download tier, so generation IS what's being sold — free would leave
  // nothing to charge for, and assertPaidAccessInput rejects that shape.
  it('ignores freeGeneration for a generation-only version', () => {
    expect(
      buildModelVersionTerms({ accessPrice: 500, freePreviewGenerations: 10, genOnly: true, freeGeneration: true })
    ).toEqual({ generation: { price: 500, trialLimit: 10 } });
  });
});
