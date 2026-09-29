import { ModelVersionPricingSignal as S } from '@civitai/buzz';
import { describe, expect, it } from 'vitest';
import {
  pickInitialVersionIndex,
  resolveSelectedIndex,
  showsPricingFilter,
  toResourceSelectFilterInput,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { ResourceFilter } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { versionSatisfiesPricingFilter } from '~/shared/search/model-pricing-filter';
import type { ModelPricingFilter } from '~/shared/search/model-pricing-filter';
import type { ModelType } from '~/shared/utils/prisma/enums';

type V = { name: string; baseModel: string; pricing: S[] };

const paid: S[] = [S.PayToGenerate];
const free: S[] = [S.Free, S.GenerationFree];

const v = (name: string, baseModel: string, pricing: S[]): V => ({ name, baseModel, pricing });

const pick = (versions: V[], filter: ModelPricingFilter, compatible: string[]) =>
  pickInitialVersionIndex(versions, {
    filter,
    satisfiesFilter: (x) => versionSatisfiesPricingFilter(x.pricing, filter),
    isCompatible: (x) => compatible.includes(x.baseModel),
  });

describe('pickInitialVersionIndex', () => {
  const ALL = ['SDXL', 'SD1.5'];

  /**
   * The short-circuit, and the reason it lives in this function rather than at the call site: with no
   * filter the card must open on index 0 exactly as it always has. Re-selecting on compatibility alone
   * would silently move it — so the case that proves it needs an INCOMPATIBLE first version, which a
   * compatibility-only implementation would skip.
   */
  it('returns index 0 with no filter, even when the first version is incompatible', () => {
    expect(pick([v('a', 'SD1.5', free), v('b', 'SDXL', free)], {}, ['SDXL'])).toBe(0);
    expect(pick([v('a', 'SDXL', paid), v('b', 'SDXL', free)], {}, ALL)).toBe(0);
  });

  it('skips a paid version for the first free one when hiding paid', () => {
    expect(pick([v('a', 'SDXL', paid), v('b', 'SDXL', free)], { hidePaid: true }, ALL)).toBe(1);
  });

  /**
   * The flattening case this rule exists for: the model matched `versions.pricing = GenerationFree`
   * on its SD1.5 version and the base-model clause on its SDXL one, so no single version satisfies
   * both — and the card must still open on the compatible one.
   */
  it('prefers a COMPATIBLE paid version over a free incompatible one', () => {
    const versions = [v('sdxl-paid', 'SDXL', paid), v('sd15-free', 'SD1.5', free)];
    expect(pick(versions, { hidePaid: true }, ['SDXL'])).toBe(0);
  });

  it('takes the free version when it is also compatible', () => {
    const versions = [
      v('sdxl-paid', 'SDXL', paid),
      v('sd15-free', 'SD1.5', free),
      v('sdxl-free', 'SDXL', free),
    ];
    expect(pick(versions, { hidePaid: true }, ['SDXL'])).toBe(2);
  });

  it('a download-gated but generation-free version counts as free', () => {
    const versions = [v('a', 'SDXL', paid), v('b', 'SDXL', [S.GenerationFree, S.PayToDownload])];
    expect(pick(versions, { hidePaid: true }, ALL)).toBe(1);
  });

  it('falls back to index 0 when nothing is compatible rather than returning -1', () => {
    expect(pick([v('a', 'SD1.5', free), v('b', 'SD1.5', paid)], { hidePaid: true }, ['SDXL'])).toBe(
      0
    );
  });

  it('an empty version list yields 0, not -1', () => {
    expect(pick([], { hidePaid: true }, ALL)).toBe(0);
  });
});

describe('resolveSelectedIndex', () => {
  const base = { filterKey: 'true', versionCount: 3, initialIndex: 2 };

  it('uses the override when its key matches the active filter', () => {
    expect(resolveSelectedIndex({ ...base, override: { key: 'true', index: 1 } })).toBe(1);
  });

  // The bug this exists for: a mounted card outlives a filter change, so an override captured under
  // the old filter must not survive it — otherwise ticking "Hide paid" leaves the paid version shown.
  it('DROPS an override captured under a different filter', () => {
    expect(resolveSelectedIndex({ ...base, override: { key: 'false', index: 1 } })).toBe(2);
  });

  it('drops an override pointing past the end of a shorter version list', () => {
    expect(resolveSelectedIndex({ ...base, override: { key: 'true', index: 9 } })).toBe(2);
  });

  it('falls back to the initial index when there is no override', () => {
    expect(resolveSelectedIndex({ ...base, override: null })).toBe(2);
  });
});

describe('showsPricingFilter', () => {
  it.each([
    ['generation', true],
    ['training', false],
    ['addResource', false],
    ['modelVersion', false],
    ['auction', false],
  ] as const)('%s -> %s', (source, expected) => {
    expect(showsPricingFilter(source)).toBe(expected);
  });
});

describe('toResourceSelectFilterInput', () => {
  /**
   * 🔴 The single wire between the chip and the query. Dropping `hidePaid` here leaves the chip
   * rendering, the filter count incrementing and the "Clear all" button appearing while the server
   * filters nothing — and because the tRPC field is optional, typecheck stays green.
   */
  it('forwards every ResourceFilter key to the tRPC input', () => {
    const filters: Required<ResourceFilter> = {
      types: ['LORA' as ModelType],
      baseModels: ['SDXL 1.0'] as ResourceFilter['baseModels'],
      loadedOnly: true,
      hidePaid: true,
    };
    expect(toResourceSelectFilterInput(filters)).toEqual({
      filterTypes: ['LORA'],
      filterBaseModels: ['SDXL 1.0'],
      filterLoaded: true,
      hidePaid: true,
    });
    // Every key of the filter is accounted for — a new one added without a wire fails here.
    expect(Object.keys(toResourceSelectFilterInput(filters))).toHaveLength(
      Object.keys(filters).length
    );
  });

  it('passes hidePaid through as undefined when unset, so the clause stays off', () => {
    expect(
      toResourceSelectFilterInput({ types: [], baseModels: [], loadedOnly: false }).hidePaid
    ).toBeUndefined();
  });
});
