import { describe, expect, it } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevelLabels,
  isOffsiteContentRating,
  OFFSITE_CONTENT_RATING_LABELS,
  OFFSITE_CONTENT_RATING_LADDER,
  offsiteContentRatingLabel,
} from '~/shared/constants/browsingLevel.constants';
import { OFFSITE_CONTENT_RATINGS } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App-listing CONTENT-RATING display labels (blocking `unit` project).
 *
 * The stored value (`app_listings.content_rating`) is one of five lowercase keys.
 * Until this map existed, three surfaces each invented their own rendering of them:
 * the store detail rail and the moderator queue printed the raw key (a tester read
 * "the category and rating are lowercase" in the store preview), the off-site submit
 * form uppercased it to `PG13`, and title-casing would have produced `Pg13`.
 *
 * These assertions pin the WORDS as literals. They are deliberately NOT derived from
 * the map under test — an expectation read out of the implementation asserts only
 * that the implementation equals itself.
 */

describe('OFFSITE_CONTENT_RATING_LABELS — the taxonomy is fully and exclusively covered', () => {
  it('the ladder under test is the schema taxonomy (not a drifted copy)', () => {
    expect([...OFFSITE_CONTENT_RATING_LADDER]).toEqual([...OFFSITE_CONTENT_RATINGS]);
  });

  it('every rating has a label, and there are no labels for non-existent ratings', () => {
    for (const r of OFFSITE_CONTENT_RATING_LADDER) {
      expect(OFFSITE_CONTENT_RATING_LABELS[r]).toBeTruthy();
    }
    expect(Object.keys(OFFSITE_CONTENT_RATING_LABELS).sort()).toEqual(
      [...OFFSITE_CONTENT_RATING_LADDER].sort()
    );
  });

  /**
   * 🔴 The literal words, each rung asserted separately.
   *
   * Every expected string here is DISTINCT from every other, and — critically —
   * distinct from its own key under any mechanical transformation of that key. A
   * mutant that hardcodes one label, or that swaps two of them, moves exactly one
   * of these assertions and names it in the failure.
   */
  it('🔴 each rung reads its chosen word', () => {
    expect(OFFSITE_CONTENT_RATING_LABELS.g).toBe('G');
    expect(OFFSITE_CONTENT_RATING_LABELS.pg).toBe('PG');
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).toBe('PG-13');
    expect(OFFSITE_CONTENT_RATING_LABELS.r).toBe('R');
    expect(OFFSITE_CONTENT_RATING_LABELS.x).toBe('X');
  });

  /**
   * 🔴 NO LABEL IS DERIVABLE FROM ITS KEY. This is the assertion the whole map
   * exists for: the reported defect was a surface rendering the key, and the
   * near-miss fixes are `toUpperCase()` (`PG13`) and title-case (`Pg13`).
   *
   * `pg13` is the rung that discriminates — it is the ONLY key whose label is not
   * simply its own uppercase — so it is asserted against both transformations by
   * name rather than left to a loop that `g`/`r`/`x` would satisfy trivially.
   */
  it('🔴 `pg13` is spelled with a hyphen — no transformation of the key produces it', () => {
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).not.toBe('pg13');
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).not.toBe('pg13'.toUpperCase());
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).not.toBe('Pg13');
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).toContain('-');
  });

  it('every label differs from its own raw key (nothing renders the enum)', () => {
    for (const r of OFFSITE_CONTENT_RATING_LADDER) {
      expect(OFFSITE_CONTENT_RATING_LABELS[r]).not.toBe(r);
    }
  });

  it('the five labels are pairwise distinct', () => {
    const labels = OFFSITE_CONTENT_RATING_LADDER.map((r) => OFFSITE_CONTENT_RATING_LABELS[r]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/**
 * 🔴 SEAM GUARD — a RELATIONSHIP, not a component.
 *
 * Four of the five rungs name a maturity level Civitai already spells for users on
 * models, images and posts (`browsingLevelLabels`). Pinning them to that map is
 * what stops the store growing a SECOND maturity vocabulary: rewording either side
 * alone goes red, and rewording both together (the legitimate case) stays green.
 *
 * `g` is deliberately absent from this check — the browsing ladder has no bit for
 * it, which is precisely why it is the one word this map had to choose on its own.
 */
describe('🔴 the rating labels ARE the site-wide maturity vocabulary', () => {
  it('the four overlapping rungs are byte-identical to browsingLevelLabels', () => {
    expect(OFFSITE_CONTENT_RATING_LABELS.pg).toBe(browsingLevelLabels[NsfwLevel.PG]);
    expect(OFFSITE_CONTENT_RATING_LABELS.pg13).toBe(browsingLevelLabels[NsfwLevel.PG13]);
    expect(OFFSITE_CONTENT_RATING_LABELS.r).toBe(browsingLevelLabels[NsfwLevel.R]);
    expect(OFFSITE_CONTENT_RATING_LABELS.x).toBe(browsingLevelLabels[NsfwLevel.X]);
  });

  it('`g` is the one rung with no browsing-level counterpart, and reads "G"', () => {
    expect(Object.values(browsingLevelLabels)).not.toContain('G');
    expect(OFFSITE_CONTENT_RATING_LABELS.g).toBe('G');
  });
});

describe('isOffsiteContentRating', () => {
  it('accepts exactly the ladder and rejects everything else', () => {
    for (const r of OFFSITE_CONTENT_RATING_LADDER) expect(isOffsiteContentRating(r)).toBe(true);
    // `xxx` is a real rung of the BROWSING ladder that this taxonomy does not have —
    // the most likely wrong value to arrive here, so it is the guard's control.
    expect(isOffsiteContentRating('xxx')).toBe(false);
    expect(isOffsiteContentRating('PG-13')).toBe(false);
    expect(isOffsiteContentRating('')).toBe(false);
    expect(isOffsiteContentRating(null)).toBe(false);
    expect(isOffsiteContentRating(13)).toBe(false);
  });
});

describe('offsiteContentRatingLabel', () => {
  it('maps every known rating to its label', () => {
    expect(offsiteContentRatingLabel('g')).toBe('G');
    expect(offsiteContentRatingLabel('pg')).toBe('PG');
    expect(offsiteContentRatingLabel('pg13')).toBe('PG-13');
    expect(offsiteContentRatingLabel('r')).toBe('R');
    expect(offsiteContentRatingLabel('x')).toBe('X');
  });

  /**
   * 🔴 THE FALLBACK — the guard most likely to be dropped as "dead code".
   *
   * `contentRating` is a nullable free-text column, and the backfill service
   * explicitly handles "a poison row (an out-of-domain contentRating)", so an
   * unknown value genuinely reaches renderers. It must degrade to the STORED
   * STRING: blank is a bug report, and a throw inside a details row unmounts the
   * page it decorates.
   *
   * The three fixtures are pairwise distinct AND distinct from every label the
   * assertions above name, so none of them can be produced by a mutant that
   * hardcodes a constant.
   */
  it('🔴 an unknown rating falls back to the RAW value — never blank, never a throw', () => {
    expect(offsiteContentRatingLabel('nc17')).toBe('nc17');
    expect(offsiteContentRatingLabel('xxx')).toBe('xxx');
    expect(offsiteContentRatingLabel('unrated-legacy')).toBe('unrated-legacy');
    expect(() => offsiteContentRatingLabel('nc17')).not.toThrow();
  });

  it('🔴 the fallback is not a blanket passthrough — a KNOWN value is still mapped', () => {
    // Negative control for the test above: if the function were `(r) => r` every
    // fallback assertion would pass while the reported bug remained live.
    expect(offsiteContentRatingLabel('pg13')).not.toBe('pg13');
  });

  it('the empty string passes through rather than becoming a label', () => {
    expect(offsiteContentRatingLabel('')).toBe('');
  });
});
