import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  getIsSafeBrowsingLevel,
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
  parseBitwiseBrowsingLevel,
  sfwBrowsingLevelsArray,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// The `disableMinor` addon (fires at mature browsing levels) must hide minor-flagged
// rows ONLY when they are also mature. SFW minor content (PG / PG-13) stays visible.
// These predicates mirror the enforcement dialects verbatim so a change to the SFW
// boundary (or a fail-open regression) trips the suite.
//
// CRITICAL: Image.nsfwLevel is a SINGLE bit (Math.max), but Model / model3d nsfwLevel is
// a COMPOSITE bit_or (a minor model rated PG in one image and R in another is PG|R = 5).
// For composites an intersect test (`& sfw != 0` / `IN [sfw]`) is NOT enough — it matches
// on the PG bit while the R bit rides along. Composite sites use a SUBSET test: an SFW bit
// present AND no mature bit present.

// --- single-bit (image) dialects: intersect == subset here ---

// SQL: (minor != TRUE OR (nsfwLevel & sfwFlag) != 0). NULL nsfwLevel → NULL → row hidden.
const imageSqlKeepsRow = (minor: boolean, nsfwLevel: number | null) =>
  !minor || (nsfwLevel != null && (nsfwLevel & sfwBrowsingLevelsFlag) !== 0);

// Meili scalar field: (minor != true OR nsfwLevel IN [1, 2])
const imageMeiliKeepsRow = (minor: boolean, nsfwLevel: number | null) =>
  !minor || (nsfwLevel != null && sfwBrowsingLevelsArray.includes(nsfwLevel as never));

// --- composite (model / model3d) dialects: MUST be subset ---

// SQL: (minor = false OR ((nsfwLevel & sfwFlag) != 0 AND (nsfwLevel & nsfwFlag) = 0))
const modelSqlKeepsRow = (minor: boolean, nsfwLevel: number | null) =>
  !minor ||
  (nsfwLevel != null &&
    (nsfwLevel & sfwBrowsingLevelsFlag) !== 0 &&
    (nsfwLevel & nsfwBrowsingLevelsFlag) === 0);

// Meili ARRAY field: nsfwLevel is expanded to its constituent bits, e.g. PG|R → [1, 4].
// (minor != true OR (nsfwLevel IN [sfw] AND NOT nsfwLevel IN [mature])) with array `IN`
// meaning "any element matches" — so the intersect form [1,4] IN [1,2] would leak on
// element 1; the mature-exclusion clause is what closes it.
const modelMeiliKeepsRow = (minor: boolean, nsfwLevel: number | null) => {
  if (!minor) return true;
  if (nsfwLevel == null || nsfwLevel === 0) return false;
  const bits = parseBitwiseBrowsingLevel(nsfwLevel);
  const anySfw = bits.some((b) => sfwBrowsingLevelsArray.includes(b as never));
  const anyMature = bits.some((b) => nsfwBrowsingLevelsArray.includes(b as never));
  return anySfw && !anyMature;
};

// Client (useApplyHiddenPreferences): drop iff minor && !getIsSafeBrowsingLevel(nsfwLevel).
// getIsSafeBrowsingLevel = level !== 0 && !intersects(level, nsfwFlag) — a subset test, so
// it is correct for BOTH single-bit and composite rows.
const clientKeepsRow = (minor: boolean, nsfwLevel: number) =>
  !(minor && !getIsSafeBrowsingLevel(nsfwLevel));

const singleBitDialects: Array<[string, (minor: boolean, nsfwLevel: number | null) => boolean]> = [
  ['image-sql', imageSqlKeepsRow],
  ['image-meili', imageMeiliKeepsRow],
  ['client', (minor, level) => clientKeepsRow(minor, level ?? 0)],
];

const compositeDialects: Array<[string, (minor: boolean, nsfwLevel: number | null) => boolean]> = [
  ['model-sql', modelSqlKeepsRow],
  ['model-meili-array', modelMeiliKeepsRow],
  ['client', (minor, level) => clientKeepsRow(minor, level ?? 0)],
];

const PG_R = NsfwLevel.PG | NsfwLevel.R; // 5
const PG_X = NsfwLevel.PG | NsfwLevel.X; // 9
const PG_PG13 = NsfwLevel.PG | NsfwLevel.PG13; // 3 (SFW-only composite)

describe('sfw-minor visibility gate', () => {
  describe.each(singleBitDialects)('%s (single-bit) predicate', (_name, keepsRow) => {
    it('shows SFW minor content (PG, PG-13)', () => {
      expect(keepsRow(true, NsfwLevel.PG)).toBe(true);
      expect(keepsRow(true, NsfwLevel.PG13)).toBe(true);
    });

    it('hides mature minor content (R, X, XXX)', () => {
      expect(keepsRow(true, NsfwLevel.R)).toBe(false);
      expect(keepsRow(true, NsfwLevel.X)).toBe(false);
      expect(keepsRow(true, NsfwLevel.XXX)).toBe(false);
    });

    it('hides minor content with NULL/0 nsfwLevel (fail closed)', () => {
      expect(keepsRow(true, 0)).toBe(false);
      expect(keepsRow(true, null)).toBe(false);
    });

    it('never touches non-minor content at any level', () => {
      for (const level of [
        0,
        NsfwLevel.PG,
        NsfwLevel.PG13,
        NsfwLevel.R,
        NsfwLevel.X,
        NsfwLevel.XXX,
      ])
        expect(keepsRow(false, level)).toBe(true);
    });
  });

  describe.each(compositeDialects)('%s (composite) predicate', (_name, keepsRow) => {
    it('shows SFW-only composites (PG, PG-13, PG|PG-13)', () => {
      expect(keepsRow(true, NsfwLevel.PG)).toBe(true);
      expect(keepsRow(true, NsfwLevel.PG13)).toBe(true);
      expect(keepsRow(true, PG_PG13)).toBe(true);
    });

    it('HIDES composite minor+mature (PG|R = 5, PG|X = 9) — the leak', () => {
      expect(keepsRow(true, PG_R)).toBe(false);
      expect(keepsRow(true, PG_X)).toBe(false);
    });

    it('hides pure-mature and NULL/0 composites', () => {
      expect(keepsRow(true, NsfwLevel.R)).toBe(false);
      expect(keepsRow(true, 0)).toBe(false);
      expect(keepsRow(true, null)).toBe(false);
    });

    it('never touches non-minor composites', () => {
      for (const level of [PG_R, PG_X, PG_PG13, NsfwLevel.PG, NsfwLevel.XXX])
        expect(keepsRow(false, level)).toBe(true);
    });
  });

  it('demonstrates the intersect gate would LEAK composites (regression guard)', () => {
    const intersectKeepsRow = (minor: boolean, nsfwLevel: number) =>
      !minor || (nsfwLevel & sfwBrowsingLevelsFlag) !== 0;
    expect(intersectKeepsRow(true, PG_R)).toBe(true); // old gate leaks a minor+mature row
    expect(modelSqlKeepsRow(true, PG_R)).toBe(false); // shipped subset gate does not
    expect(clientKeepsRow(true, PG_R)).toBe(false);
  });

  it('SFW flag is exactly {PG, PG-13}, disjoint from every mature bit', () => {
    expect(sfwBrowsingLevelsArray).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
    for (const mature of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX])
      expect(sfwBrowsingLevelsFlag & mature).toBe(0);
  });
});
