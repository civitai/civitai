import { describe, expect, it } from 'vitest';
import { baseModelRecords, licenses as sharedLicenses } from '@civitai/shared/basemodel.constants';
import {
  baseModelLicenses,
  getEffectiveDifferentLicense,
  requiresSameLicenseBaseModel,
  sameLicenseBaseModels,
} from '~/server/common/constants';
import type { BaseModel } from '~/server/common/constants';

// Lightricks licenses LTX releases under different agreements. The Jan 2026 text that
// LTXV2 / LTXV 2.3 carry lets a creator put "additional or different" terms on a
// derivative; the Aug 2026 text that LTXV 2.5 carries drops "or different" in its
// section 3.6 and allows additive terms only. So the same-license lock applies to 2.5
// and must NOT apply to the 2.x line.
const AUG_TEXT: BaseModel[] = ['LTXV 2.5'];
const JAN_TEXT: BaseModel[] = ['LTXV2', 'LTXV 2.3'];
const OWN_TEXT: BaseModel[] = ['LTXV']; // 0.9.x, a separate Lightricks licence

// Exact permalinks. `baseModelLicenses` cannot audit itself, so the LTX list is derived
// from `baseModelRecords` — the registry of what actually exists — and matched loosely
// on name, because a future release may be styled `LTX 2.6` rather than `LTXV 2.6`.
const PERMALINKS: Record<string, string> = {
  LTXV: 'https://huggingface.co/Lightricks/LTX-Video/blob/8984fa25007f376c1a299016d0957a37a2f797bb/LTX-Video-Open-Weights-License-0.X.txt',
  LTXV2:
    'https://huggingface.co/Lightricks/LTX-2.3/blob/6f3520585aa27248020550da2f453aa0c572398c/LICENSE',
  'LTXV 2.3':
    'https://huggingface.co/Lightricks/LTX-2.3/blob/6f3520585aa27248020550da2f453aa0c572398c/LICENSE',
  'LTXV 2.5':
    'https://github.com/Lightricks/LTX-2/blob/2362161611a61154d342e02724fb8fe58efd455d/LICENSE.md',
};

const KNOWN_LTX: BaseModel[] = [...OWN_TEXT, ...JAN_TEXT, ...AUG_TEXT];
const LTX_RECORD_NAMES = baseModelRecords
  .map((r) => r.name)
  .filter((name) => /^LTX/i.test(name)) as BaseModel[];

describe('LTX same-license enforcement', () => {
  it.each(AUG_TEXT)('forces allowDifferentLicense off for %s', (baseModel) => {
    expect(getEffectiveDifferentLicense(true, baseModel)).toBe(false);
    expect(requiresSameLicenseBaseModel(baseModel)).toBe(true);
  });

  it.each([...JAN_TEXT, ...OWN_TEXT])('leaves the creator permission alone for %s', (baseModel) => {
    expect(getEffectiveDifferentLicense(true, baseModel)).toBe(true);
    expect(requiresSameLicenseBaseModel(baseModel)).toBe(false);
  });

  // The whitelist, not a spot-check. Adding `requiresSameLicense` to any other licence —
  // e.g. flux1D, which six Flux base models share — would silently lock merges on models
  // whose licence does not require it. Enumerating a couple of unrelated names misses that.
  it('locks exactly the base models whose licence requires it, and no others', () => {
    expect([...sameLicenseBaseModels].sort()).toEqual([...AUG_TEXT].sort());
  });

  it('does not constrain a base model absent from the licence map', () => {
    expect(getEffectiveDifferentLicense(true, undefined)).toBe(true);
    expect(getEffectiveDifferentLicense(true, null)).toBe(true);
    expect(getEffectiveDifferentLicense(true, 'Not A Real Base Model')).toBe(true);
  });

  // `requiresSameLicense ? false : allowDifferentLicense` returns false either way when the
  // stored value is already false, so asserting that case alone proves nothing. This pins
  // that a locked model ignores the stored value and an unlocked one reads through to it.
  it('ignores the stored permission only where the licence requires it', () => {
    for (const baseModel of AUG_TEXT) {
      expect(getEffectiveDifferentLicense(true, baseModel)).toBe(
        getEffectiveDifferentLicense(false, baseModel)
      );
    }
    for (const baseModel of [...JAN_TEXT, ...OWN_TEXT]) {
      expect(getEffectiveDifferentLicense(true, baseModel)).not.toBe(
        getEffectiveDifferentLicense(false, baseModel)
      );
    }
  });
});

describe('LTX licence records', () => {
  // Derived from the RECORD registry, not from the licence map, so a new LTX release added
  // to `baseModelRecords` without a licence decision fails here. `BaseModel` is `string`,
  // so nothing in the type system forces that key to exist — 21 base models ship without one.
  it('accounts for every LTX base model that exists', () => {
    expect(LTX_RECORD_NAMES.length).toBeGreaterThanOrEqual(4); // positive control
    expect(
      [...LTX_RECORD_NAMES].sort(),
      'A new LTX base model exists without a licence decision. Read which agreement its ' +
        'weights shipped under, then add it to OWN_TEXT, JAN_TEXT or AUG_TEXT and give it ' +
        'an entry in baseModelLicenses + PERMALINKS.'
    ).toEqual([...KNOWN_LTX].sort());
  });

  it('gives every LTX base model a licence', () => {
    for (const baseModel of LTX_RECORD_NAMES) {
      expect(baseModelLicenses[baseModel], `${baseModel} has no licence`).toBeDefined();
    }
  });

  it('keeps the 2.x and 2.5 records distinct', () => {
    expect(baseModelLicenses['LTXV 2.3']?.name).toBe('LTX-2 Community License Agreement');
    expect(baseModelLicenses['LTXV 2.5']?.name).toBe('LTX-2.x Community License Agreement');
    expect(baseModelLicenses['LTXV2']?.url).toBe(baseModelLicenses['LTXV 2.3']?.url);
  });

  // The exact string is the only assertion that pins repo, path AND revision together. A
  // shape guard alone lets 2.x be cross-wired onto the Aug-text repo at some other SHA.
  it.each(KNOWN_LTX)('pins %s to its exact licence permalink', (baseModel) => {
    expect(baseModelLicenses[baseModel]?.url).toBe(PERMALINKS[baseModel]);
  });

  // ...and the shape guard is what stops a future edit sliding back onto a moving ref.
  // Both copies of the records, since only one of them is currently read at runtime.
  it('pins every LTX licence URL to an immutable 40-hex revision', () => {
    const sharedLtxUrls = sharedLicenses
      .filter((l) => /^LTX/i.test(l.name))
      .map((l) => [l.name, l.url] as const);
    expect(sharedLtxUrls.length).toBeGreaterThanOrEqual(3); // positive control

    const all = [
      ...KNOWN_LTX.map((b) => [b, baseModelLicenses[b]?.url ?? ''] as const),
      ...sharedLtxUrls,
    ];
    for (const [label, url] of all) {
      expect(url, `${label} is not pinned to a commit revision`).toMatch(/\/blob\/[0-9a-f]{40}\//);
    }
  });

  // Both copies must agree — `civitai-shared` is inert today (`getBaseModelLicense` has no
  // callers) but it is the copy a future consumer would read. Keyed to the licence id, not
  // `some()` over the array: presence anywhere would let id 35 hold the 2.5 permalink.
  it.each([
    [16, PERMALINKS['LTXV']],
    [35, PERMALINKS['LTXV 2.3']],
    [40, PERMALINKS['LTXV 2.5']],
  ])('keeps @civitai/shared licence %i on the same permalink', (id, url) => {
    const shared = sharedLicenses.find((l) => l.id === id);
    expect(shared, `@civitai/shared has no licence id ${id}`).toBeDefined();
    expect(shared?.url).toBe(url);
  });

  it('gives 2.5 a notice covering redistribution and the revenue threshold', () => {
    const notice = baseModelLicenses['LTXV 2.5']?.notice ?? '';
    expect(notice).toContain('Lightricks');
    expect(notice).toContain('$10,000,000');
    expect(notice).toMatch(/same agreement/i);
  });
});
