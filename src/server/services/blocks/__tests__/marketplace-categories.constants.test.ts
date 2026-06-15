import { describe, expect, it } from 'vitest';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
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
    expect(Object.keys(MARKETPLACE_CATEGORY_LABELS).sort()).toEqual([...MARKETPLACE_CATEGORIES].sort());
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

  it('listAvailable sort defaults to popular and rejects unknown sorts', () => {
    expect(listAvailableSchema.parse({}).sort).toBe('popular');
    for (const s of ['popular', 'newest', 'name']) {
      expect(listAvailableSchema.parse({ sort: s }).sort).toBe(s);
    }
    expect(() => listAvailableSchema.parse({ sort: 'trending' })).toThrow();
  });
});
