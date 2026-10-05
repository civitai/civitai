import { describe, expect, it } from 'vitest';
import { buildModelVersionTerms } from './paid-access';
import {
  ModelVersionPricingSignal,
  modelVersionPricingSignals,
  resolveModelVersionPricing,
} from './model-version-pricing';

const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);

const gate = (terms: ReturnType<typeof buildModelVersionTerms>, endsAt: Date | null = null) => ({
  endsAt,
  terms,
});

const S = ModelVersionPricingSignal;

describe('resolveModelVersionPricing', () => {
  it('is free with no gate', () => {
    expect(resolveModelVersionPricing({})).toEqual({
      free: true,
      payToGenerate: false,
      payToDownload: false,
    });
  });

  it('a paid download with free generation is NOT pay-to-generate', () => {
    const terms = buildModelVersionTerms({ accessPrice: 500, freeGeneration: true });
    const p = resolveModelVersionPricing({ paidAccess: gate(terms) });
    expect(p.payToGenerate).toBe(false);
    expect(p.payToDownload).toBe(true);
    expect(p.free).toBe(false);
  });

  it('a generation-only gate is pay-to-generate and not pay-to-download', () => {
    const terms = buildModelVersionTerms({ accessPrice: 200, genOnly: true });
    const p = resolveModelVersionPricing({ paidAccess: gate(terms) });
    expect(p.payToGenerate).toBe(true);
    expect(p.payToDownload).toBe(false);
  });

  it('generation BUNDLED with the download (no cheaper tier) is pay-to-generate', () => {
    // `buildModelVersionTerms` always emits a `generation` key, so the bundled shape is built by hand —
    // it is what a version with only a download grant stores, and it must not read as free.
    const p = resolveModelVersionPricing({ paidAccess: gate({ download: { price: 500 } }) });
    expect(p.payToGenerate).toBe(true);
    expect(p.payToDownload).toBe(true);
  });

  it('an expired gate prices nothing', () => {
    const terms = buildModelVersionTerms({ accessPrice: 500 });
    expect(resolveModelVersionPricing({ paidAccess: gate(terms, past) })).toEqual({
      free: true,
      payToGenerate: false,
      payToDownload: false,
    });
  });

  it('a live timed window still prices', () => {
    const terms = buildModelVersionTerms({ accessPrice: 500 });
    expect(resolveModelVersionPricing({ paidAccess: gate(terms, future) }).payToGenerate).toBe(
      true
    );
  });
});

describe('toPricingSignals', () => {
  it('an ungated version carries Free and GenerationFree', () => {
    expect(modelVersionPricingSignals({})).toEqual([S.Free, S.GenerationFree]);
  });

  it('a gen-only gate carries neither Free nor GenerationFree', () => {
    const terms = buildModelVersionTerms({ accessPrice: 200, genOnly: true });
    expect(modelVersionPricingSignals({ paidAccess: gate(terms) })).toEqual([S.PayToGenerate]);
  });

  /** The shape the whole per-version design exists for: model-level `hasActivePaidAccess` calls it paid. */
  it('a paid download with free generation is GenerationFree — the generator sees it as free', () => {
    const terms = buildModelVersionTerms({ accessPrice: 500, freeGeneration: true });
    const signals = modelVersionPricingSignals({ paidAccess: gate(terms) });
    expect(signals).toEqual([S.GenerationFree, S.PayToDownload]);
    expect(signals).not.toContain(S.Free);
  });

  it('NEVER returns an empty array, whatever the gate', () => {
    const shapes = [
      null,
      gate(buildModelVersionTerms({ accessPrice: 200, genOnly: true })),
      gate(buildModelVersionTerms({ accessPrice: 500, freeGeneration: true })),
      gate(buildModelVersionTerms({ accessPrice: 500 })),
      gate(buildModelVersionTerms({ accessPrice: 500 }), past),
    ];
    for (const paidAccess of shapes)
      expect(modelVersionPricingSignals({ paidAccess }).length).toBeGreaterThan(0);
  });

  it('Free is ordinal 0 — a stray filter(Boolean) downstream would drop it', () => {
    expect(S.Free).toBe(0);
    expect(modelVersionPricingSignals({})).toContain(S.Free);
  });
});
