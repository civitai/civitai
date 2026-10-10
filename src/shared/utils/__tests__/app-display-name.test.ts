import { describe, expect, it } from 'vitest';
import { appDisplayName } from '~/shared/utils/app-display-name';

/**
 * The display-name rule that four call sites open-coded and two of them got differently.
 *
 * 🔴 THE EMPTY-STRING CASE IS THE WHOLE REASON THIS MODULE EXISTS, and it is also the one
 * case the two server copies answered differently from the two client ones: they tested
 * `typeof name === 'string'` alone, so `""` rendered a blank identity, while the client
 * copies fell back to the slug.
 *
 * ⚠️ IT IS NOT REACHABLE TODAY, which is why consolidating changed no observable
 * behaviour: `name` is required with `minLength: 1` in `public/schemas/app-block/v1.json`,
 * `submitVersion` throws `manifest.name must be a non-empty string`, and
 * `BlockManifestValidator` rejects it on the git-push and approve paths. Pinned anyway —
 * the value is publisher-authored JSON read back out of a `Json` column, so "no writer can
 * produce it" is a claim about today's writers, not about the column.
 */
describe('appDisplayName', () => {
  it('prefers the manifest name', () => {
    expect(appDisplayName({ name: 'Lighthouse' }, 'lighthouse-slug')).toBe('Lighthouse');
  });

  it('🔴 falls back to the slug for an EMPTY name — never a blank identity', () => {
    expect(appDisplayName({ name: '' }, 'my-slug')).toBe('my-slug');
  });

  it('falls back for a whitespace-only name only if it is empty — a space IS a name', () => {
    // Deliberately NOT trimmed: the old copies did not, and trimming here would be a
    // behaviour change smuggled into a consolidation.
    expect(appDisplayName({ name: ' ' }, 'my-slug')).toBe(' ');
  });

  it('falls back for a missing, null or non-string name', () => {
    expect(appDisplayName({}, 'my-slug')).toBe('my-slug');
    expect(appDisplayName({ name: null }, 'my-slug')).toBe('my-slug');
    expect(appDisplayName({ name: 42 }, 'my-slug')).toBe('my-slug');
    expect(appDisplayName({ name: { en: 'x' } }, 'my-slug')).toBe('my-slug');
  });

  it('falls back for a manifest that is not an object at all', () => {
    // `manifest` is a Prisma `Json` column, so every one of these is a shape it can hold.
    for (const manifest of [null, undefined, 'a string', 7, [], true]) {
      expect(appDisplayName(manifest, 'my-slug')).toBe('my-slug');
    }
  });

  it('returns the fallback VERBATIM — it is the caller’s slug or blockId, not derived', () => {
    // The two server call sites pass different fallbacks (`row.slug`, `appBlock.blockId`),
    // which is why it is a parameter rather than something this helper computes.
    expect(appDisplayName({}, 'UPPER_and-weird.chars')).toBe('UPPER_and-weird.chars');
  });
});
