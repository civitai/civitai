import { ModelVersionPricingSignal } from '@civitai/buzz';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  modelPricingFilterClause,
  versionIsPaidToGenerate,
  versionSatisfiesPricingFilter,
} from '~/shared/search/model-pricing-filter';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';

const S = ModelVersionPricingSignal;

describe('modelPricingFilterClause', () => {
  it('is null by default — no pricing filter applies unless asked for', () => {
    expect(modelPricingFilterClause({})).toBeNull();
    expect(modelPricingFilterClause({ hidePaid: false })).toBeNull();
  });

  /**
   * The `NOT ... EXISTS` half is why the backfill covers only the ~3K gated models: an absent
   * attribute means "not rewritten since the field shipped", and those must SHOW rather than vanish.
   * Dropping it turns a 3K sweep into a 713K one, silently, the moment someone tidies this up.
   */
  it('matches GenerationFree positively, OR the absence of the attribute', () => {
    expect(modelPricingFilterClause({ hidePaid: true })).toBe(
      `(versions.pricing = ${S.GenerationFree} OR NOT versions.pricing EXISTS)`
    );
  });

  /**
   * `versions[]` is flattened, so a NEGATION matches only models where NO version is gated — hiding
   * partially-paid models that the product deliberately keeps visible. It would pass a smoke test on
   * a single-version model, which is most of them.
   */
  /**
   * 🔴 Pins the ALLOWED shape, not a list of forbidden ones.
   *
   * The hazard is any negation of the MEMBER — flattening turns it into "no version is gated", which
   * hides the partially-paid models the product keeps visible. Negating EXISTS is a different
   * operator and is required. An earlier version of this test enumerated the bad spellings (`=`,
   * `!=`, `not(eq(`) and a `not(inArray(...))` walked straight through it, emitting
   * `NOT versions.pricing IN [1]` — the exact hazard, green suite. Enumerating spellings cannot work:
   * the builder can always grow another one. So assert the whole clause instead.
   */
  it('emits ONLY the allowed shape — any other negation of the member fails', () => {
    const clause = modelPricingFilterClause({ hidePaid: true })!;
    expect(clause).toMatch(/^\(versions\.pricing = \d+ OR NOT versions\.pricing EXISTS\)$/);
    // Belt and braces, and the assertion that keeps reading true if the shape above ever changes:
    // NOT may precede the field only when EXISTS follows it.
    expect(clause).not.toMatch(/NOT\s+versions\.pricing\s+(?!EXISTS)/);
    expect(clause).not.toMatch(/versions\.pricing\s*!=/);
    expect(clause).not.toMatch(/ AND /);
  });

  it('filters a field the models index actually exposes', () => {
    expect(modelsFilterableAttributes).toContain('versions.pricing');
  });
});

describe('versionSatisfiesPricingFilter', () => {
  const gated = [S.PayToGenerate];
  const free = [S.Free, S.GenerationFree];
  const downloadGatedOnly = [S.GenerationFree, S.PayToDownload];

  it('accepts every version when nothing is filtered', () => {
    expect(versionSatisfiesPricingFilter(gated, {})).toBe(true);
    expect(versionSatisfiesPricingFilter(undefined, {})).toBe(true);
  });

  // Deliberately the same answer the CLAUSE gives an un-backfilled document. The card must not
  // second-guess a model the query already returned — disagreeing here would skip past the version
  // the server matched on.
  it('a version predating the field passes, matching the clause', () => {
    expect(versionSatisfiesPricingFilter(undefined, { hidePaid: true })).toBe(true);
    expect(versionSatisfiesPricingFilter([], { hidePaid: true })).toBe(true);
  });

  it.each([
    [gated, false],
    [free, true],
    [downloadGatedOnly, true],
  ])('%o against hidePaid', (pricing, expected) => {
    expect(versionSatisfiesPricingFilter(pricing, { hidePaid: true })).toBe(expected);
  });
});

/**
 * 🔴 The badge and the filter read DIFFERENT members, and they are not complements. A document
 * predating `versions.pricing` carries neither, so the filter SHOWS it — fail-open, which is what
 * lets the backfill cover only the gated models — while the badge stays silent rather than claiming
 * a charge it cannot evidence. Pinned as a pair so the next person to "unify" them has to delete an
 * assertion that says why.
 */
describe('versionIsPaidToGenerate vs versionSatisfiesPricingFilter', () => {
  it.each([
    ['gated', [S.PayToGenerate], true, false],
    ['free', [S.Free, S.GenerationFree], false, true],
    ['download-gated, generation-free', [S.GenerationFree, S.PayToDownload], false, true],
    // The un-backfilled case: SHOWN by the filter (its document predates the field), never badged.
    ['no signals yet', undefined, false, true],
  ] as const)('%s', (_label, pricing, paid, passesFilter) => {
    expect(versionIsPaidToGenerate(pricing as ModelVersionPricingSignal[] | undefined)).toBe(paid);
    expect(
      versionSatisfiesPricingFilter(pricing as ModelVersionPricingSignal[] | undefined, {
        hidePaid: true,
      })
    ).toBe(passesFilter);
  });
});
