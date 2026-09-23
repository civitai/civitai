import { describe, expect, it } from 'vitest';
import {
  allBrowsingLevelsFlag,
  allowMatureContentForCeiling,
  contentRatingFromNsfwLevel,
  deriveContentRatingFromAssets,
  domainBrowsingCeiling,
  effectiveBrowsingCeiling,
  nsfwBrowsingLevelsFlag,
  nsfwLevelFromContentRating,
  OFFSITE_CONTENT_RATING_LADDER,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { OFFSITE_CONTENT_RATINGS } from '~/server/schema/blocks/offsite-listing.schema';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * App Blocks maturity policy — the single source of truth.
 *
 * `domainBrowsingCeiling` maps a color domain to the max browsing-level flag a
 * block on that domain may render/generate. PRODUCT DECISION: green AND blue
 * both clamp to SFW; only red permits mature. Unknown/missing domains fail
 * CLOSED to SFW.
 */
describe('domainBrowsingCeiling', () => {
  it('green → SFW (PG + PG13)', () => {
    expect(domainBrowsingCeiling('green')).toBe(sfwBrowsingLevelsFlag);
  });

  it('blue → SFW (product decision — deliberately NOT mature)', () => {
    expect(domainBrowsingCeiling('blue')).toBe(sfwBrowsingLevelsFlag);
  });

  it('blue maps to the SAME ceiling as green', () => {
    expect(domainBrowsingCeiling('blue')).toBe(domainBrowsingCeiling('green'));
  });

  it('red → all browsing levels (no clamp)', () => {
    expect(domainBrowsingCeiling('red')).toBe(allBrowsingLevelsFlag);
  });

  it('SFW ceiling contains NO nsfw bits', () => {
    expect(Flags.intersects(domainBrowsingCeiling('green'), nsfwBrowsingLevelsFlag)).toBe(false);
    expect(Flags.intersects(domainBrowsingCeiling('blue'), nsfwBrowsingLevelsFlag)).toBe(false);
  });

  it('red ceiling DOES contain nsfw bits', () => {
    expect(Flags.intersects(domainBrowsingCeiling('red'), nsfwBrowsingLevelsFlag)).toBe(true);
  });

  it('fails CLOSED to SFW on undefined domain', () => {
    expect(domainBrowsingCeiling(undefined)).toBe(sfwBrowsingLevelsFlag);
  });

  it('fails CLOSED to SFW on null domain', () => {
    expect(domainBrowsingCeiling(null)).toBe(sfwBrowsingLevelsFlag);
  });

  it('fails CLOSED to SFW on an unknown domain value', () => {
    // Cast through unknown — defends the runtime default branch even if a
    // future caller passes a value outside the ColorDomain union.
    expect(domainBrowsingCeiling('purple' as unknown as 'green')).toBe(sfwBrowsingLevelsFlag);
  });

  it('the SFW ceiling is never the empty (0) flag — a clamp must always permit PG', () => {
    expect(domainBrowsingCeiling(undefined)).not.toBe(0);
    // PG must always be permitted on a SFW domain.
    expect(Flags.intersects(domainBrowsingCeiling('green'), publicBrowsingLevelsFlag)).toBe(true);
  });
});

describe('allowMatureContentForCeiling', () => {
  it('SFW ceiling → false (block mature output)', () => {
    expect(allowMatureContentForCeiling(sfwBrowsingLevelsFlag)).toBe(false);
  });

  it('PG-only ceiling → false', () => {
    expect(allowMatureContentForCeiling(publicBrowsingLevelsFlag)).toBe(false);
  });

  it('all-levels ceiling → undefined (no clamp)', () => {
    expect(allowMatureContentForCeiling(allBrowsingLevelsFlag)).toBeUndefined();
  });

  it('a ceiling carrying even a single nsfw bit → undefined (no clamp)', () => {
    // NsfwLevel.R = 4 → mature allowed.
    expect(allowMatureContentForCeiling(4)).toBeUndefined();
  });

  it('an empty (0) ceiling → false (most restrictive)', () => {
    expect(allowMatureContentForCeiling(0)).toBe(false);
  });

  it('composes with domainBrowsingCeiling: green/blue → false, red → undefined', () => {
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('green'))).toBe(false);
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('blue'))).toBe(false);
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('red'))).toBeUndefined();
    expect(allowMatureContentForCeiling(domainBrowsingCeiling(undefined))).toBe(false);
  });
});

/**
 * Off-site content-rating derive (App Blocks W13). The scanner's per-image rating
 * is imprecise, so the AUTHOR is never blocked on it — the authoritative rating is
 * DERIVED from the assets' max detected nsfwLevel at review + a mod override
 * (floored). The forward (`nsfwLevelFromContentRating`) + inverse
 * (`contentRatingFromNsfwLevel`) must round-trip and fail CLOSED (never under-rate).
 */
describe('off-site content-rating derive', () => {
  it('the ladder is kept in sync with the schema OFFSITE_CONTENT_RATINGS', () => {
    expect([...OFFSITE_CONTENT_RATING_LADDER]).toEqual([...OFFSITE_CONTENT_RATINGS]);
  });

  it('nsfwLevelFromContentRating: g/pg → PG, and the rest via the orchestrator map', () => {
    expect(nsfwLevelFromContentRating('g')).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('pg')).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('pg13')).toBe(NsfwLevel.PG13);
    expect(nsfwLevelFromContentRating('r')).toBe(NsfwLevel.R);
    expect(nsfwLevelFromContentRating('x')).toBe(NsfwLevel.X);
    // null / unknown fail CLOSED to PG (never widen on ambiguity).
    expect(nsfwLevelFromContentRating(null)).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('bogus')).toBe(NsfwLevel.PG);
  });

  it('contentRatingFromNsfwLevel maps each level to the MINIMAL covering rating', () => {
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG)).toBe('g'); // g and pg share the PG ceiling → g is minimal
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG13)).toBe('pg13');
    expect(contentRatingFromNsfwLevel(NsfwLevel.R)).toBe('r');
    expect(contentRatingFromNsfwLevel(NsfwLevel.X)).toBe('x');
    // No maturity signal → the lowest rating.
    expect(contentRatingFromNsfwLevel(0)).toBe('g');
  });

  it('fails CLOSED for a level above the x ceiling (XXX / Blocked) → the TOP rating', () => {
    expect(contentRatingFromNsfwLevel(NsfwLevel.XXX)).toBe('x');
    expect(contentRatingFromNsfwLevel(NsfwLevel.Blocked)).toBe('x');
  });

  it('reads the HIGHEST bit of a composite level (never a lower one)', () => {
    // Composite PG | R → the R bit governs → 'r' (not 'g').
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG | NsfwLevel.R)).toBe('r');
  });

  it('deriveContentRatingFromAssets picks the rating covering the MAX asset level', () => {
    expect(
      deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }, { nsfwLevel: NsfwLevel.R }])
    ).toBe('r');
    expect(
      deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }, { nsfwLevel: NsfwLevel.PG13 }])
    ).toBe('pg13');
    // All PG → g (g/pg share the PG ceiling, g is minimal).
    expect(deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }])).toBe('g');
  });

  it('deriveContentRatingFromAssets is fail-safe for empty / null / undefined levels → g', () => {
    expect(deriveContentRatingFromAssets([])).toBe('g');
    expect(deriveContentRatingFromAssets([{ nsfwLevel: null }, { nsfwLevel: undefined }])).toBe(
      'g'
    );
    expect(deriveContentRatingFromAssets([{}])).toBe('g');
  });

  it('deriveContentRatingFromAssets fails CLOSED to the top rating for an XXX asset', () => {
    expect(deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.XXX }])).toBe('x');
  });
});

/**
 * `effectiveBrowsingCeiling` — the DOMAIN ceiling ∩ the VIEWER's own level.
 *
 * This is the value projected into `BLOCK_INIT` as `effectiveBrowsingLevel`.
 * `domainBrowsingCeiling` above answers "what may be shown on this domain";
 * this answers "what may be shown to THIS person, here", which is the question
 * a block actually needs and the one `maxBrowsingLevel` alone cannot answer.
 *
 * 🔴 The two inputs disagree in BOTH directions in production — blue makes the
 * viewer the wider one, red makes the domain the wider one — so every fixture
 * below is a disagreeing pair. An agreeing pair cannot tell an intersection
 * apart from either operand.
 */
describe('effectiveBrowsingCeiling', () => {
  it('🔴 blue: the VIEWER is wider and loses — SFW(3) ∩ PG|PG13|R|X(15) → 3', () => {
    // The concrete footgun. `domainBrowsingCeiling('blue')` is SFW for App
    // Blocks while the site treats blue as mature, so a blue-domain viewer's
    // saved level routinely carries R/X. The domain must win.
    expect(effectiveBrowsingCeiling(domainBrowsingCeiling('blue'), 15)).toBe(sfwBrowsingLevelsFlag);
    expect(
      Flags.intersects(
        effectiveBrowsingCeiling(domainBrowsingCeiling('blue'), 15),
        nsfwBrowsingLevelsFlag
      )
    ).toBe(false);
  });

  it('🔴 red: the DOMAIN is wider and loses — all(31) ∩ PG(1) → 1', () => {
    expect(effectiveBrowsingCeiling(domainBrowsingCeiling('red'), NsfwLevel.PG)).toBe(NsfwLevel.PG);
  });

  it('returns NEITHER operand when both carry bits the other lacks: 11 ∩ 22 → 2', () => {
    // 11 = PG|PG13|X, 22 = PG13|R|XXX. An implementation returning either side,
    // a min, or an OR (31) all give a different answer.
    expect(effectiveBrowsingCeiling(11, 22)).toBe(2);
  });

  it('is always a subset of the domain ceiling over the whole 5-bit lattice', () => {
    for (let ceiling = 0; ceiling < 32; ceiling++) {
      for (let viewer = 0; viewer < 32; viewer++) {
        expect(effectiveBrowsingCeiling(ceiling, viewer) & ~ceiling).toBe(0);
      }
    }
  });

  it('fails closed on an absent/malformed DOMAIN ceiling → SFW ∩ viewer', () => {
    // Same fallback `domainBrowsingCeiling` uses for an unknown domain. The
    // viewer here is all-levels, so a fallback of "all" would read 31.
    expect(effectiveBrowsingCeiling(undefined, allBrowsingLevelsFlag)).toBe(sfwBrowsingLevelsFlag);
    expect(effectiveBrowsingCeiling(null, allBrowsingLevelsFlag)).toBe(sfwBrowsingLevelsFlag);
    expect(effectiveBrowsingCeiling(NaN, allBrowsingLevelsFlag)).toBe(sfwBrowsingLevelsFlag);
  });

  it('🔴 fails closed on an absent/malformed/negative VIEWER level → PG, not the ceiling', () => {
    // PG (`publicBrowsingLevelsFlag`), matching what `getServerBrowsingLevel`
    // returns for an anonymous viewer: "we could not establish who is looking"
    // and "nobody is looking" must land on the same narrowest answer.
    const red = domainBrowsingCeiling('red');
    expect(effectiveBrowsingCeiling(red, undefined)).toBe(publicBrowsingLevelsFlag);
    expect(effectiveBrowsingCeiling(red, null)).toBe(publicBrowsingLevelsFlag);
    expect(effectiveBrowsingCeiling(red, NaN)).toBe(publicBrowsingLevelsFlag);
    // 🔴 −1 has every bit set, so masking it would return the FULL ceiling —
    // junk resolving to the widest possible viewer.
    expect(effectiveBrowsingCeiling(red, -1)).toBe(publicBrowsingLevelsFlag);
    expect(effectiveBrowsingCeiling(red, -1)).not.toBe(red);
  });

  it('an empty viewer level (0) yields 0 — a real answer, not a fallback', () => {
    expect(effectiveBrowsingCeiling(allBrowsingLevelsFlag, 0)).toBe(0);
  });
});

/**
 * The composition actually shipped by the token mint's
 * `resolveEffectiveBrowsingLevel`: `getServerBrowsingLevel` (the platform's
 * existing source of truth for the viewer's own level — the same helper
 * `wildcard-pack.service.ts` gates downloads on) fed into
 * `effectiveBrowsingCeiling` against the domain ceiling already computed for
 * the token claim.
 *
 * Pinned here because the mint's own helper is a private route-local function:
 * these are its two operands, and the anonymous / NSFW-off / no-level-set cases
 * the projection must fail closed on are decided entirely by this pair.
 */
describe('mint composition: getServerBrowsingLevel → effectiveBrowsingCeiling', () => {
  const compose = (
    color: 'green' | 'blue' | 'red',
    canViewNsfw: boolean,
    user?: { showNsfw?: boolean | null; browsingLevel?: number | null } | null
  ) =>
    effectiveBrowsingCeiling(
      domainBrowsingCeiling(color),
      getServerBrowsingLevel({ canViewNsfw, user })
    );

  it('ANONYMOUS on red (the widest domain) collapses to PG', () => {
    // The domain permits everything; the absence of a viewer is what narrows it.
    expect(compose('red', true, null)).toBe(publicBrowsingLevelsFlag);
    expect(compose('red', true, undefined)).toBe(publicBrowsingLevelsFlag);
  });

  it('a signed-in viewer with NSFW OFF on red collapses to PG', () => {
    expect(compose('red', true, { showNsfw: false, browsingLevel: allBrowsingLevelsFlag })).toBe(
      publicBrowsingLevelsFlag
    );
  });

  it('a signed-in viewer with NSFW ON but NO saved level on red collapses to PG', () => {
    expect(compose('red', true, { showNsfw: true, browsingLevel: null })).toBe(
      publicBrowsingLevelsFlag
    );
    expect(compose('red', true, { showNsfw: true, browsingLevel: 0 })).toBe(
      publicBrowsingLevelsFlag
    );
  });

  it('🔴 a full-NSFW viewer on BLUE is still clamped to SFW — the viewer cannot widen the domain', () => {
    // canViewNsfw is TRUE on blue site-wide, so `getServerBrowsingLevel` hands
    // back the raw all-levels preference; only the domain ceiling stops it.
    const viewer = getServerBrowsingLevel({
      canViewNsfw: true,
      user: { showNsfw: true, browsingLevel: allBrowsingLevelsFlag },
    });
    expect(viewer).toBe(allBrowsingLevelsFlag); // the raw level IS wider than blue allows
    expect(compose('blue', true, { showNsfw: true, browsingLevel: allBrowsingLevelsFlag })).toBe(
      sfwBrowsingLevelsFlag
    );
  });

  it('a full-NSFW viewer on RED keeps the mature levels (the feature is not a blanket clamp)', () => {
    expect(compose('red', true, { showNsfw: true, browsingLevel: allBrowsingLevelsFlag })).toBe(
      allBrowsingLevelsFlag
    );
  });

  it('a PG13-only viewer on red gets PG13 — the domain does not widen the viewer either', () => {
    const level = Flags.addFlag(NsfwLevel.PG, NsfwLevel.PG13);
    expect(compose('red', true, { showNsfw: true, browsingLevel: level })).toBe(level);
  });
});
