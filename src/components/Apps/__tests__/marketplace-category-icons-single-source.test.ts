import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

/**
 * M2 (audit) — the category→icon map is a SINGLE shared source.
 *
 * Before the fix, `AppBlockCard.tsx` declared its OWN private `CATEGORY_ICONS`
 * map AND `marketplaceCategoryIcons.ts` declared a second copy that the filter
 * buttons used — two maps that could silently diverge. The fix makes
 * `marketplaceCategoryIcons.ts` the single exported source; BOTH the card chip
 * and the filter-button row import `CATEGORY_ICONS` from it.
 *
 * This is a structural guard (a node unit test, no browser): it asserts the card
 * no longer DECLARES its own map and instead imports the shared one — so a
 * future edit can't reintroduce the duplicate without failing here.
 */
const APPS_DIR = path.resolve(__dirname, '..');

function read(file: string): string {
  return readFileSync(path.join(APPS_DIR, file), 'utf8');
}

describe('marketplace category icons — single shared source (M2)', () => {
  test('marketplaceCategoryIcons.ts exports CATEGORY_ICONS and the fallback', () => {
    const src = read('marketplaceCategoryIcons.ts');
    expect(src).toMatch(/export const CATEGORY_ICONS\b/);
    expect(src).toMatch(/export const FALLBACK_CATEGORY_ICON\b/);
  });

  test('AppBlockCard.tsx imports the shared CATEGORY_ICONS and does NOT declare its own', () => {
    const src = read('AppBlockCard.tsx');
    // Imports from the shared module…
    expect(src).toMatch(/from '~\/components\/Apps\/marketplaceCategoryIcons'/);
    expect(src).toMatch(/CATEGORY_ICONS/);
    // …and no longer declares a private copy (the dup that M2 removed).
    expect(src).not.toMatch(/const CATEGORY_ICONS\s*:/);
    // The card keeps its IconTag fallback path via the shared FALLBACK const.
    expect(src).toMatch(/FALLBACK_CATEGORY_ICON/);
  });

  test('CategoryFilterButtons.tsx imports the shared map + fallback', () => {
    const src = read('CategoryFilterButtons.tsx');
    expect(src).toMatch(/from '~\/components\/Apps\/marketplaceCategoryIcons'/);
    expect(src).toMatch(/CATEGORY_ICONS\[category\] \?\? FALLBACK_CATEGORY_ICON/);
    // No private copy here either.
    expect(src).not.toMatch(/const CATEGORY_ICONS\s*:/);
  });
});

/**
 * M3 (audit) — the Sort onChange fallback matches the visible default.
 *
 * The Sort select's initial state used to be 'rating' while the clear/onChange
 * fallback coerced to 'popular' — a silent mismatch (clearing the control jumped
 * to a DIFFERENT sort than the one shown as default). This is a structural guard
 * (the Mantine Select uses allowDeselect={false}, so onChange(null) can't be
 * driven from the UI in a browser test).
 *
 * 🔴 The three values are DERIVED from the source, not hardcoded, so this keeps
 * pinning the AGREEMENT rather than one spelling of it. That matters: the guard
 * used to name 'rating' literally, and when the 5-star `AppBlockReview` system
 * (and with it the `rating` sort) was removed, a literal assertion would have had
 * to be rewritten — which is exactly the moment a real mismatch slips in.
 */
describe('MarketplaceBody — sort default/fallback agree (M3)', () => {
  test('the initial sort, the onChange fallback and the FIRST offered option are all the same value', () => {
    const src = readFileSync(path.resolve(APPS_DIR, 'MarketplaceBody.tsx'), 'utf8');

    const initial = /useState<MarketplaceSort>\('([a-z-]+)'\)/.exec(src)?.[1];
    const fallback = /setSort\(\(v as MarketplaceSort\) \?\? '([a-z-]+)'\)/.exec(src)?.[1];
    const firstOption = /SORT_OPTIONS[^=]*=\s*\[\s*\{\s*value: '([a-z-]+)'/.exec(src)?.[1];

    // Positive control: all three patterns actually matched something. Without
    // this a renamed hook/prop would make every comparison below `undefined ===
    // undefined` and the guard would pass while checking nothing.
    expect(initial).toBeDefined();
    expect(fallback).toBeDefined();
    expect(firstOption).toBeDefined();

    expect(fallback).toBe(initial);
    expect(firstOption).toBe(initial);
  });
});
