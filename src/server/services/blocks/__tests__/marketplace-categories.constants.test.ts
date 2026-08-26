import { describe, expect, it } from 'vitest';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  marketplaceCategoryLabel,
} from '../marketplace-categories.constants';
import { listAvailableSchema } from '~/server/schema/blocks/subscription.schema';

/**
 * F-E E3 — the marketplace category taxonomy is a SINGLE source of truth
 * (`MARKETPLACE_CATEGORIES`) reused by the schema validation, the UI, and the
 * mod tooling. These tests pin that single-source contract so the schema and
 * the const can't drift (adding a category must be a one-line const edit).
 */
describe('marketplace-categories taxonomy (F-E E3)', () => {
  it('has the resolved MVP set', () => {
    expect([...MARKETPLACE_CATEGORIES]).toEqual([
      'generation',
      'games',
      'utility',
      'discovery',
      'moderation',
      'analytics',
      'other',
    ]);
  });

  it('every category has a display label', () => {
    for (const c of MARKETPLACE_CATEGORIES) {
      expect(MARKETPLACE_CATEGORY_LABELS[c]).toBeTruthy();
    }
    // No stray labels for non-existent categories.
    expect(Object.keys(MARKETPLACE_CATEGORY_LABELS).sort()).toEqual(
      [...MARKETPLACE_CATEGORIES].sort()
    );
  });

  it('isMarketplaceCategory accepts exactly the taxonomy and rejects everything else', () => {
    for (const c of MARKETPLACE_CATEGORIES) expect(isMarketplaceCategory(c)).toBe(true);
    expect(isMarketplaceCategory('not-a-category')).toBe(false);
    expect(isMarketplaceCategory('')).toBe(false);
    expect(isMarketplaceCategory(null)).toBe(false);
    expect(isMarketplaceCategory(123)).toBe(false);
  });

  it('the listAvailable schema category enum IS the taxonomy const (single source of truth)', () => {
    // Accepts every taxonomy member.
    for (const c of MARKETPLACE_CATEGORIES) {
      const parsed = listAvailableSchema.parse({ category: c });
      expect(parsed.category).toBe(c);
    }
    // Rejects a value outside the taxonomy — proving the enum is derived from
    // the const, not a hand-maintained copy that could silently drift.
    expect(() => listAvailableSchema.parse({ category: 'not-a-category' })).toThrow();
  });

  /**
   * 🔴 `marketplaceCategoryLabel` — the ONE display rule, extracted because it had
   * been open-coded at four sites and skipped at four more, which is how the raw
   * lowercase `utility` reached a tester in the store preview.
   *
   * The expected words are LITERALS, not `MARKETPLACE_CATEGORY_LABELS[c]` — reading
   * the expectation out of the map under test would assert only that the map equals
   * itself, and would stay green through a mutant that swapped two labels.
   */
  it('🔴 marketplaceCategoryLabel maps every taxonomy value to its display label', () => {
    expect(marketplaceCategoryLabel('generation')).toBe('Generation');
    expect(marketplaceCategoryLabel('games')).toBe('Games');
    expect(marketplaceCategoryLabel('utility')).toBe('Utility');
    expect(marketplaceCategoryLabel('discovery')).toBe('Discovery');
    expect(marketplaceCategoryLabel('moderation')).toBe('Moderation');
    expect(marketplaceCategoryLabel('analytics')).toBe('Analytics');
    expect(marketplaceCategoryLabel('other')).toBe('Other');
  });

  it('🔴 no category renders its raw stored value (the reported defect)', () => {
    for (const c of MARKETPLACE_CATEGORIES) {
      expect(marketplaceCategoryLabel(c)).not.toBe(c);
    }
  });

  /**
   * 🔴 THE FALLBACK — the guard `AppBlockCard` already carried and the one most
   * likely to be dropped when the helper is "simplified".
   *
   * `app_blocks.category` / `app_listings.category` is FREE TEXT, and adding a
   * category is a one-line const edit with no migration, so a client older than the
   * taxonomy will meet a value it has no label for. It must show the stored string —
   * a blank chip is a bug report, a throw takes the surrounding surface down.
   *
   * The fixtures are pairwise distinct and share no substring with any label above,
   * so a mutant returning a hardcoded constant cannot satisfy them.
   */
  it('🔴 an unknown category falls back to the RAW value — never blank, never a throw', () => {
    expect(marketplaceCategoryLabel('workflow-tools')).toBe('workflow-tools');
    expect(marketplaceCategoryLabel('legacy_bucket')).toBe('legacy_bucket');
    expect(() => marketplaceCategoryLabel('workflow-tools')).not.toThrow();
    // Negative control for the two assertions above: a blanket `(c) => c` would pass
    // them while leaving the reported bug live.
    expect(marketplaceCategoryLabel('utility')).not.toBe('utility');
  });

  it('listAvailable sort defaults to rating and rejects unknown sorts', () => {
    // #2668 (marketplace reviews + Bayesian rating sort) made `rating` a sort
    // option AND the default so the best-reviewed apps surface first; the
    // pre-#2668 default was `popular`.
    expect(listAvailableSchema.parse({}).sort).toBe('rating');
    for (const s of ['rating', 'popular', 'newest', 'name']) {
      expect(listAvailableSchema.parse({ sort: s }).sort).toBe(s);
    }
    expect(() => listAvailableSchema.parse({ sort: 'trending' })).toThrow();
  });
});
