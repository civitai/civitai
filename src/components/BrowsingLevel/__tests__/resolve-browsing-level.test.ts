import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  resolvePageBrowsingLevel,
  resolveViewerBrowsingLevel,
} from '~/components/BrowsingLevel/resolve-browsing-level';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

describe('resolvePageBrowsingLevel', () => {
  it('lets a page override the viewer for its own subtree', () => {
    expect(resolvePageBrowsingLevel({ override: NsfwLevel.PG, user: allBrowsingLevelsFlag })).toBe(
      NsfwLevel.PG
    );
  });

  it('puts the domain cap above the page override', () => {
    expect(
      resolvePageBrowsingLevel({
        forced: publicBrowsingLevelsFlag,
        override: NsfwLevel.XXX,
        user: allBrowsingLevelsFlag,
      })
    ).toBe(publicBrowsingLevelsFlag);
  });

  it('falls back to the viewer when no page asked for anything', () => {
    expect(resolvePageBrowsingLevel({ user: sfwBrowsingLevelsFlag })).toBe(sfwBrowsingLevelsFlag);
  });
});

describe('resolveViewerBrowsingLevel', () => {
  /**
   * The reason this function exists. `ImageDetail2` wraps its sidebar in a
   * provider set to the host image's rating, and anything in there reading the
   * page level is scoped to that image — including a list of OTHER people's
   * images, whose entries then cannot intersect it and vanish. Measured on prod
   * 2026-08-29: 161 of 488 approved remix-gallery entries invisible that way,
   * 160 of them paid.
   *
   * Asserted as "the override changes nothing" rather than against a number, so
   * this fails for anyone who routes this back through the page resolution.
   */
  it('ignores a page override — that is the whole point of it', () => {
    const user = allBrowsingLevelsFlag;

    expect(resolveViewerBrowsingLevel({ user })).toBe(user);
    // Same call with an override in scope must give the same answer. The typed
    // signature omits `override`, so this is what a caller passing the full
    // context object would produce.
    expect(resolveViewerBrowsingLevel({ user, ...({ override: NsfwLevel.PG } as object) })).toBe(
      user
    );
  });

  /**
   * 🔴 THE SAFETY PROPERTY. Named for the decision so the next person to
   * "simplify" this to `user` alone has to delete a test that says why not.
   *
   * `forced` is the domain cap and it mirrors the server middleware: anonymous
   * is PG anywhere, and a logged-in viewer on the green domain is PG+PG-13
   * regardless of what they saved in their settings. Skipping the PAGE override
   * must not also skip that.
   *
   * If this ever fails, do not adjust the expectation — a signed-in viewer whose
   * preference is "everything" is being served everything on a domain that is
   * not allowed to serve it.
   */
  it('keeps the domain cap above the viewer preference', () => {
    expect(
      resolveViewerBrowsingLevel({ forced: sfwBrowsingLevelsFlag, user: allBrowsingLevelsFlag }),
      'the green-domain cap must beat a saved preference of allBrowsingLevels'
    ).toBe(sfwBrowsingLevelsFlag);

    expect(
      resolveViewerBrowsingLevel({ forced: publicBrowsingLevelsFlag, user: allBrowsingLevelsFlag }),
      'the anonymous cap must beat a saved preference of allBrowsingLevels'
    ).toBe(publicBrowsingLevelsFlag);
  });

  /**
   * The two resolutions must agree wherever no page set an override — that is
   * what makes the gallery on a detail page show the same entries as the flyout
   * on a feed card, which is the behaviour that was asked for.
   */
  it.each([
    ['anonymous', { forced: publicBrowsingLevelsFlag, user: publicBrowsingLevelsFlag }],
    ['green domain', { forced: sfwBrowsingLevelsFlag, user: allBrowsingLevelsFlag }],
    ['uncapped', { user: allBrowsingLevelsFlag }],
  ])('agrees with the page resolution when nothing overrode it (%s)', (_label, inputs) => {
    expect(resolveViewerBrowsingLevel(inputs)).toBe(resolvePageBrowsingLevel(inputs));
  });
});

/**
 * The call site, not the function.
 *
 * Everything above tests a pure resolver that `RemixGalleryCard` merely has to
 * CHOOSE to use. The bug was never in the resolver — it was one hook name at one
 * call site, and unit-testing the resolver would have proved nothing about it.
 * The hooks are React, so a render test lands in the `component` project, which
 * runs in no CI job; this reads the source instead.
 *
 * ⚠️ What this does and does not catch, stated because a source guard flatters
 * itself: it catches reverting to `useBrowsingLevelDebounced`, which is the
 * regression that actually happened. It would NOT catch someone reading
 * `useBrowsingLevelContext()` and resolving the level by hand. It pins a
 * spelling, and the spelling it pins is the likely one.
 */
describe('the remix gallery reads the viewer, not the page', () => {
  const cardPath = path.resolve(__dirname, '..', '..', 'RemixGallery', 'RemixGalleryCard.tsx');
  // Throws rather than passing if the file moves or is renamed. A guard whose
  // subject has vanished must go red, not quietly become vacuous.
  const source = readFileSync(cardPath, 'utf-8');

  it('is reading the file it thinks it is', () => {
    expect(source, 'wrong file — this guard is pointed at nothing').toContain('RemixGalleryCard');
  });

  it('uses the viewer hook', () => {
    expect(source).toContain('useViewerBrowsingLevelDebounced()');
  });

  /**
   * 🔴 `ImageDetail2` wraps this card in a provider set to the HOST image's
   * rating. The ordinary hook inherits that, which scopes a list of other
   * people's images to the rating of the image they hang beside — entries above
   * the host cannot intersect it and vanish for every viewer, including the owner
   * who approved and was paid for them. Measured on prod 2026-08-29: 161 of 488
   * approved entries invisible that way, 160 of them paid.
   *
   * Do not "simplify" this back. The domain cap is still honoured by the viewer
   * hook; skipping the page override is the entire point.
   */
  it('does NOT use the page-scoped hook', () => {
    expect(
      source.includes('useBrowsingLevelDebounced()'),
      'RemixGalleryCard must not inherit the detail page browsing-level override'
    ).toBe(false);
  });
});
