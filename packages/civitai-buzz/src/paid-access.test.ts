import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  acceptsBlueBuzz,
  buildModelVersionTerms,
  migrateTermsForUsageControl,
  generationOpenToNonBuyers,
  generationPrice,
  generationTrialLimit,
  grantsGeneration,
  isFreeGeneration,
  isPaidAccessActive,
  isTimedGateActive,
  paidGenerationGrant,
  paidAccessBlockedFor,
  licensingFeeBlockedFor,
  separateGenerationPriceMissing,
  CAP_TIERS,
  nextCapTier,
  shouldUpsellCap,
  cappedTerms,
  maxPaidAccessPrice,
  maxPermanentAccessModels,
  tierCapRows,
  type ModelVersionTerms,
  type ModelVersionSaleWindow,
  discountedTerms,
  maxSaleDays,
  remainingSaleDays,
  saleDaysCharged,
  saleDaysUsed,
  SALE_DAYS_BY_TIER,
} from './paid-access';
import {
  MAX_LICENSING_FEE,
  feeToRatio,
  VIDEO_CAP_MULTIPLIER,
  effectiveLicensingFee,
  maxLicensingFee,
  maxLicensingFeeCeiling,
  suggestedFeePerImage,
} from './licensing-fee';
import { capMediaType } from './media-type';

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
  const paidGen: ModelVersionTerms = {
    download: { price: 500 },
    generation: { price: 200, trialLimit: 5 },
  };
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

describe('model-level monetization policy', () => {
  it('refuses a gate on a POI model, and on a private one', () => {
    expect(paidAccessBlockedFor({ poi: true, availability: 'Public' })).toBe(true);
    expect(paidAccessBlockedFor({ poi: false, availability: 'Private' })).toBe(true);
  });
  it('allows a gate on an ordinary public model', () => {
    expect(paidAccessBlockedFor({ poi: false, availability: 'Public' })).toBe(false);
  });
  // The asymmetry is deliberate: a private model has no audience to sell access to, but its fee is for
  // when it is published. A POI model earns nothing either way.
  it('refuses a licensing fee on a POI model but keeps it on a private one', () => {
    expect(licensingFeeBlockedFor({ poi: true, availability: 'Public' })).toBe(true);
    expect(licensingFeeBlockedFor({ poi: false, availability: 'Private' })).toBe(false);
  });
  // Rows arrive from two apps and two ORMs; an absent column must not read as permission granted by
  // accident, nor as a block that strands every save.
  it('treats missing fields as unblocked rather than guessing', () => {
    expect(paidAccessBlockedFor({})).toBe(false);
    expect(licensingFeeBlockedFor({ poi: null })).toBe(false);
  });
});

describe('separateGenerationPriceMissing — the blank "cheaper price" box', () => {
  it('a stated price is not missing', () => {
    expect(separateGenerationPriceMissing(200)).toBe(false);
  });
  it.each([
    ['undefined', undefined],
    ['null', null],
    // Defensive: the form's zod schema rejects NaN before the guard runs, and its number input maps a
    // cleared box to undefined. Kept so the predicate is total for callers without that schema.
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -50],
  ])('%s is missing', (_label, value) => {
    expect(separateGenerationPriceMissing(value as number | null | undefined)).toBe(true);
  });
  it('what an unrefused blank costs the buyer: the FULL download price', () => {
    const blank = buildModelVersionTerms({ accessPrice: 500, generationPrice: undefined });
    expect(generationPrice(blank)).toBe(500);
  });
});

describe('grantsGeneration — the full access decision', () => {
  const bundled: ModelVersionTerms = { download: { price: 500 } };
  const trial: ModelVersionTerms = {
    download: { price: 500 },
    generation: { price: 200, trialLimit: 5 },
  };
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
      buildModelVersionTerms({
        accessPrice: 500,
        freePreviewGenerations: 10,
        genOnly: true,
        freeGeneration: true,
      })
    ).toEqual({ generation: { price: 500, trialLimit: 10 } });
  });
});

describe('acceptsBlueBuzz — an extra accepted currency, not a second price', () => {
  it('is absent by default and set only when opted in', () => {
    const base = { accessPrice: 500, freePreviewGenerations: 10 };
    expect(buildModelVersionTerms(base)).not.toHaveProperty('acceptsBlueBuzz');
    expect(acceptsBlueBuzz(buildModelVersionTerms(base))).toBe(false);
    expect(buildModelVersionTerms({ ...base, acceptsBlueBuzz: true })).toEqual({
      acceptsBlueBuzz: true,
      download: { price: 500 },
      generation: { trialLimit: 10 },
    });
  });

  it('leaves the prices alone — blue and the domain currency cost the same', () => {
    const withBlue = buildModelVersionTerms({
      accessPrice: 500,
      generationPrice: 200,
      freePreviewGenerations: 10,
      acceptsBlueBuzz: true,
    });
    expect(withBlue.download?.price).toBe(500);
    expect(generationPrice(withBlue)).toBe(200);
  });

  it.each([
    ['gen-only', { accessPrice: 500, genOnly: true }],
    ['free generation', { accessPrice: 500, freeGeneration: true }],
  ])('survives the %s shape', (_label, opts) => {
    expect(acceptsBlueBuzz(buildModelVersionTerms({ ...opts, acceptsBlueBuzz: true }))).toBe(true);
  });

  it('survives price capping and a usage-control migration', () => {
    const terms = buildModelVersionTerms({ accessPrice: 5000, acceptsBlueBuzz: true });
    expect(acceptsBlueBuzz(cappedTerms(terms, 'free', { permanent: true }))).toBe(true);
    expect(acceptsBlueBuzz(migrateTermsForUsageControl(terms, true))).toBe(true);
  });
});

describe('video pricing — every ceiling is 5x on a video model', () => {
  it('multiplies the licensing-fee cap for each tier and model type', () => {
    for (const tier of CAP_TIERS) {
      for (const modelType of ['Checkpoint', 'LORA']) {
        expect(maxLicensingFee(tier, modelType, 'video')).toBe(
          maxLicensingFee(tier, modelType, 'image') * VIDEO_CAP_MULTIPLIER
        );
      }
    }
  });

  it('multiplies the paid-access price cap, leaving gold unlimited', () => {
    expect(maxPaidAccessPrice('free', 'video')).toBe(maxPaidAccessPrice('free') * 5);
    expect(maxPaidAccessPrice('silver', 'video')).toBe(maxPaidAccessPrice('silver') * 5);
    expect(maxPaidAccessPrice('gold', 'video')).toBe(Infinity);
  });

  it('multiplies the suggested default, so a new video model is not seeded too low', () => {
    expect(suggestedFeePerImage('Checkpoint', 'video')).toBe(
      suggestedFeePerImage('Checkpoint') * VIDEO_CAP_MULTIPLIER
    );
    expect(suggestedFeePerImage('LORA', 'video')).toBeCloseTo(
      suggestedFeePerImage('LORA') * VIDEO_CAP_MULTIPLIER,
      5
    );
  });

  it('does NOT multiply the permanent-gate allowance — it counts gates, it does not price them', () => {
    expect(maxPermanentAccessModels('free')).toBe(3);
    expect(tierCapRows().find((r) => r.tier === 'free')?.permanentGates).toBe(3);
  });

  it('gold video is no longer clamped by the image ceiling', () => {
    // The whole point of raising the ceiling: 5 x 100 must survive rather than saturating at 100.
    expect(maxLicensingFee('gold', 'Checkpoint', 'video')).toBe(500);
    expect(maxLicensingFeeCeiling('video')).toBe(500);
    expect(maxLicensingFeeCeiling('image')).toBe(MAX_LICENSING_FEE);
  });

  it('clamps a stored fee against the video cap, not the image one', () => {
    expect(effectiveLicensingFee(20, 'free', 'Checkpoint', 'image')).toBe(1);
    expect(effectiveLicensingFee(20, 'free', 'Checkpoint', 'video')).toBe(5);
  });

  it('prices gate terms against the video cap', () => {
    const terms = { download: { price: 5000 } };
    expect(cappedTerms(terms, 'free', { permanent: true, mediaType: 'image' })).toEqual({
      download: { price: 500 },
    });
    expect(cappedTerms(terms, 'free', { permanent: true, mediaType: 'video' })).toEqual({
      download: { price: 2500 },
    });
    // A timed early-access window has no ceiling — stored is what buyers pay.
    expect(cappedTerms(terms, 'free', { permanent: false, mediaType: 'image' })).toEqual(terms);
  });
});

describe('capMediaType — which column a base model lands in', () => {
  it('resolves a video ecosystem to video', () => {
    expect(capMediaType('Hunyuan Video')).toBe('video');
    expect(capMediaType('LTXV')).toBe('video');
  });

  it('resolves an image ecosystem to image', () => {
    expect(capMediaType('SDXL 1.0')).toBe('image');
    expect(capMediaType('Flux.1 D')).toBe('image');
  });

  it('falls back to image for anything unmatched — a miss must never widen a ceiling', () => {
    expect(capMediaType(undefined)).toBe('image');
    expect(capMediaType(null)).toBe('image');
    expect(capMediaType('')).toBe('image');
    expect(capMediaType('Other')).toBe('image');
    expect(capMediaType('not-a-real-base-model')).toBe('image');
  });
});

// The caps table renders each ceiling through feeToRatio, so a cap that can't be expressed as whole Buzz
// over 1 or 10 generations would render as an unusable ratio the editor can't accept.
it('every licensing cap is a whole number of Buzz over 1 or 10 generations', () => {
  for (const tier of CAP_TIERS)
    for (const mediaType of ['image', 'video'] as const)
      for (const modelType of ['Checkpoint', 'LORA']) {
        const { buzz, images } = feeToRatio(maxLicensingFee(tier, modelType, mediaType));
        expect([1, 10]).toContain(images);
        expect(Number.isInteger(buzz)).toBe(true);
      }
});

describe('shouldUpsellCap — nudge only when the ceiling is actually in the way', () => {
  it('offers an upgrade once the value reaches 80% of the cap', () => {
    expect(shouldUpsellCap({ value: 79, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 80, cap: 100, tier: 'free' })).toBe(true);
    expect(shouldUpsellCap({ value: 100, cap: 100, tier: 'free' })).toBe(true);
  });

  it('stays quiet for an empty or comfortably-low value', () => {
    expect(shouldUpsellCap({ value: null, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 0, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 10, cap: 100, tier: 'free' })).toBe(false);
  });

  it('never upsells gold — there is nothing above it', () => {
    expect(shouldUpsellCap({ value: 100, cap: 100, tier: 'gold' })).toBe(false);
    expect(nextCapTier('gold')).toBeNull();
  });

  // Normalising a raw tier string (founder, unknown, lapsed) is resolveCapTier's job and is tested there;
  // nextCapTier takes the canonical tier that produces, so it only has to walk the ladder.
  it('walks one step up the ladder', () => {
    expect(nextCapTier('free')).toBe('bronze');
    expect(nextCapTier('bronze')).toBe('silver');
    expect(nextCapTier('silver')).toBe('gold');
  });

  // 99999 >= Infinity * 0.8 is false by arithmetic, so an Infinity case would pass even without the
  // guard. cap: 0 is the one that actually pins it — reachable via maxFeeBuzzForRatio at the free/other
  // cap of 0.1 with a denominator of 1, where floor() yields 0.
  it('never upsells against an unlimited or zero cap', () => {
    expect(shouldUpsellCap({ value: 99999, cap: Infinity, tier: 'silver' })).toBe(false);
    expect(shouldUpsellCap({ value: 0, cap: 0, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 5, cap: 0, tier: 'free' })).toBe(false);
  });
});

describe('scheduled sales — discountedTerms', () => {
  const at = (iso: string) => new Date(iso);
  const sale = (over: Partial<ModelVersionSaleWindow> = {}): ModelVersionSaleWindow => ({
    id: 1,
    discountType: 'Percent',
    discountAmount: 20,
    startsAt: at('2026-03-01T00:00:00Z'),
    endsAt: at('2026-03-08T00:00:00Z'),
    canceledAt: null,
    ...over,
  });
  const now = at('2026-03-02T00:00:00Z');

  it('discounts BOTH the download price and a separate generation price', () => {
    const out = discountedTerms(
      { download: { price: 500 }, generation: { price: 100 } },
      [sale()],
      now
    );
    expect(out.download?.price).toBe(400);
    expect(paidGenerationGrant(out)?.price).toBe(80);
  });

  it('leaves a generation tier with no price of its own alone, so it keeps following the discounted download price', () => {
    const terms: ModelVersionTerms = { download: { price: 500 }, generation: { trialLimit: 3 } };
    const out = discountedTerms(terms, [sale()], now);
    expect(paidGenerationGrant(out)?.price).toBeUndefined();
    expect(generationPrice(out)).toBe(400);
  });

  it('never drives a price below zero when a fixed discount exceeds it', () => {
    const out = discountedTerms(
      { download: { price: 500 }, generation: { price: 100 } },
      [sale({ discountType: 'Fixed', discountAmount: 300 })],
      now
    );
    expect(out.download?.price).toBe(200);
    expect(paidGenerationGrant(out)?.price).toBe(0);
  });

  it('rounds a percentage in the buyer’s favour, never charging more than the undiscounted price', () => {
    const out = discountedTerms({ download: { price: 33 } }, [sale({ discountAmount: 33 })], now);
    // 33 * 33% = 10.89 -> 10 off, not 11: a rounding error must not take LESS off than advertised.
    expect(out.download?.price).toBe(23);
  });

  it('applies the deepest discount when two sales overlap on one version', () => {
    const out = discountedTerms(
      { download: { price: 1000 } },
      [
        sale({ id: 1, discountAmount: 10 }),
        sale({ id: 2, discountType: 'Fixed', discountAmount: 250 }),
      ],
      now
    );
    expect(out.download?.price).toBe(750);
  });

  it('ignores a sale that has not started, has ended, or was cancelled before now', () => {
    const terms: ModelVersionTerms = { download: { price: 500 } };
    const notStarted = sale({ startsAt: at('2026-03-05T00:00:00Z') });
    const ended = sale({ endsAt: at('2026-03-01T12:00:00Z') });
    const cancelled = sale({ canceledAt: at('2026-03-01T12:00:00Z') });
    for (const s of [notStarted, ended, cancelled]) {
      expect(discountedTerms(terms, [s], now).download?.price).toBe(500);
    }
  });

  it('composes OVER cappedTerms: the sale comes off what the buyer is actually billed', () => {
    // A lapsed gold creator stores 5000 but is billed the free cap of 500. 20% off must be 400 —
    // discounting first would give 4000, which the cap then flattens back to 500 and the sale vanishes.
    const stored: ModelVersionTerms = { download: { price: 5000 } };
    const gate = { permanent: true } as const;
    const billed = discountedTerms(cappedTerms(stored, 'free', gate), [sale()], now);
    expect(billed.download?.price).toBe(400);

    const wrongOrder = cappedTerms(discountedTerms(stored, [sale()], now), 'free', gate);
    expect(wrongOrder.download?.price).toBe(500);
  });
});

describe('scheduled sales — the sale-day budget', () => {
  const at = (iso: string) => new Date(iso);
  const window = (over: Partial<ModelVersionSaleWindow> = {}): ModelVersionSaleWindow => ({
    id: 1,
    discountType: 'Percent',
    discountAmount: 20,
    startsAt: at('2026-03-01T00:00:00Z'),
    endsAt: at('2026-03-08T00:00:00Z'),
    canceledAt: null,
    ...over,
  });

  it('charges the full scheduled length while the sale stands', () => {
    expect(saleDaysCharged(window())).toBe(7);
  });

  it('returns everything when a sale is cancelled before it starts', () => {
    expect(saleDaysCharged(window({ canceledAt: at('2026-02-27T00:00:00Z') }))).toBe(0);
  });

  it('returns the untaken tail when a sale is cancelled part-way through', () => {
    expect(saleDaysCharged(window({ canceledAt: at('2026-03-03T00:00:00Z') }))).toBe(2);
  });

  it('rounds a part-day up, so a run of short sales cannot slice past the budget', () => {
    const half = window({ endsAt: at('2026-03-01T12:00:00Z') });
    expect(saleDaysCharged(half)).toBe(1);
  });

  it('counts a month-crossing sale against the month it STARTS in, and only that month', () => {
    const crossing = window({
      startsAt: at('2026-03-30T00:00:00Z'),
      endsAt: at('2026-04-04T00:00:00Z'),
    });
    expect(saleDaysUsed([crossing], at('2026-03-15T00:00:00Z'))).toBe(5);
    expect(saleDaysUsed([crossing], at('2026-04-15T00:00:00Z'))).toBe(0);
  });

  it('gives an unknown or lapsed tier the FREE allowance rather than none', () => {
    expect(maxSaleDays('gold')).toBe(30);
    expect(maxSaleDays(null)).toBe(SALE_DAYS_BY_TIER.free);
    expect(maxSaleDays('nonsense')).toBe(SALE_DAYS_BY_TIER.free);
  });

  it('never reports negative remaining days after a downgrade', () => {
    const spent = [window({ startsAt: at('2026-03-01T00:00:00Z'), endsAt: at('2026-03-29T00:00:00Z') })];
    expect(remainingSaleDays('gold', spent, at('2026-03-15T00:00:00Z'))).toBe(2);
    expect(remainingSaleDays('free', spent, at('2026-03-15T00:00:00Z'))).toBe(0);
  });
});
