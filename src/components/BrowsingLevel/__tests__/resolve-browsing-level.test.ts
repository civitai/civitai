import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  intersectBrowsingCaps,
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

describe('intersectBrowsingCaps', () => {
  /**
   * 🔴 The reason this exists. The provider used to merge caps with `??`, which
   * takes the first one SET rather than the tighter of the two. A collection
   * ceiling of PG+PG-13 sitting nearer than an anonymous domain cap of PG would
   * therefore have erased it — a nearer provider lifting a ceiling further out,
   * which is the one thing a cap must never permit.
   *
   * If this fails, do not adjust the expectation.
   */
  it('takes the TIGHTER of two caps, never the nearer one', () => {
    expect(
      intersectBrowsingCaps(sfwBrowsingLevelsFlag, publicBrowsingLevelsFlag),
      'a wider nearer cap must not lift a tighter outer one'
    ).toBe(publicBrowsingLevelsFlag);
    // Order must not matter. `??` passes one of these two and fails the other,
    // which is exactly how the old behaviour looked correct half the time.
    expect(intersectBrowsingCaps(publicBrowsingLevelsFlag, sfwBrowsingLevelsFlag)).toBe(
      publicBrowsingLevelsFlag
    );
  });

  it('skips absent caps rather than treating them as a ceiling of nothing', () => {
    expect(intersectBrowsingCaps(undefined, sfwBrowsingLevelsFlag, undefined)).toBe(
      sfwBrowsingLevelsFlag
    );
  });

  /** No cap at all means no ceiling — the caller falls through to the viewer. */
  it('returns undefined when nothing caps anything', () => {
    expect(intersectBrowsingCaps(undefined, undefined)).toBeUndefined();
  });

  it('intersects three, not just the first pair', () => {
    expect(
      intersectBrowsingCaps(allBrowsingLevelsFlag, sfwBrowsingLevelsFlag, publicBrowsingLevelsFlag)
    ).toBe(publicBrowsingLevelsFlag);
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
   * The two resolutions agree wherever no page set an override.
   *
   * ⚠️ Narrower than it looks, said plainly so nobody cites it as more: with
   * `override` omitted, `resolvePageBrowsingLevel` reduces to this function's
   * own body, so two of these rows compare an implementation against a copy of
   * itself. The 'green domain' row is the one that earns its place — it fails a
   * one-sided `user ?? forced`.
   *
   * It says NOTHING about the gallery and the feed flyout agreeing. That is a
   * claim about two React trees and two providers, and no test here touches
   * either; `browsing-level-hooks.test.ts` is as close as this gets.
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
 * The call sites, not the function.
 *
 * Everything above tests pure resolvers that these components merely have to
 * CHOOSE to use. Every defect in this area so far has been one hook name at one
 * call site, and no test of a resolver can reach that. The hooks are React, so a
 * render test lands in the `component` project, which runs in no CI job; this
 * reads the sources instead.
 *
 * ⚠️ What a source guard is worth, stated because it flatters itself: it catches
 * a revert to `useBrowsingLevelDebounced`, which is the regression that keeps
 * happening. It would NOT catch someone reading `useBrowsingLevelContext()` and
 * resolving by hand. It pins a spelling, and the spelling it pins is the likely
 * one.
 *
 * 🔴 Deliberately NOT comparing path strings. `appModeratorMessageForm.callSites`
 * does, and it fails on Windows only, because it compares `a/b` against `a\b`.
 * Paths here are built with `path.resolve` and only ever used to READ.
 */
const VIEWER_SCOPED = [
  {
    file: ['..', '..', 'RemixGallery', 'RemixGalleryCard.tsx'],
    why: 'lists other people’s images beside an image scoped to its own rating',
  },
  {
    file: ['..', '..', 'RemixGallery', 'RemixGalleryBatchProvider.tsx'],
    why: 'its count must match the gallery that count opens',
  },
  {
    file: ['..', '..', 'UserAvatar', 'UserAvatar.tsx'],
    why: 'a profile picture belongs to its owner, not to the page it appears on',
  },
  {
    file: ['..', '..', 'UserAvatar', 'UserAvatarSimple.tsx'],
    why: 'a profile picture belongs to its owner, not to the page it appears on',
  },
];

// Throws rather than passing if the file moves. A guard whose subject has
// vanished must go red, not quietly become vacuous — read inside each `it` so
// that red is one failing guard rather than a collection error that also stops
// the resolver tests in this file from reporting.
const read = (...file: string[]) => readFileSync(path.resolve(__dirname, ...file), 'utf-8');

describe.each(VIEWER_SCOPED)('$file reads the viewer, not the page', ({ file, why }) => {
  it('uses the viewer hook', () => {
    expect(read(...file), why).toContain('useViewerBrowsingLevelDebounced()');
  });

  it('does NOT inherit a page override', () => {
    expect(
      read(...file).includes('useBrowsingLevelDebounced()'),
      `${file.join('/')} must not inherit a page browsing-level override: ${why}`
    ).toBe(false);
  });
});

/**
 * The other direction. A collection's ceiling is policy, not preference, so it
 * must ride the slot every hook honours — as an override it silently stopped
 * applying to each component above the moment they adopted the viewer hook.
 */
describe('a collection ceiling is a cap, not an override', () => {
  const collection = () => read('..', '..', 'Collections', 'Collection.tsx');

  it('passes it as forcedBrowsingLevel', () => {
    expect(collection()).toContain('forcedBrowsingLevel={collection.metadata.forcedBrowsingLevel');
  });

  it('does not pass it through the override slot', () => {
    expect(
      collection().includes('browsingLevel={collection.metadata.forcedBrowsingLevel'),
      'the override slot is one any component may decline to read'
    ).toBe(false);
  });
});

/**
 * 🔴 A cap that is SET imperatively must also be CLEARED imperatively.
 *
 * `PostDetail` pushes a contest collection's ceiling into the ancestor provider
 * rather than passing it as a prop, and `resolvePageBrowsingLevel` puts `forced`
 * AHEAD of the viewer's preference rather than intersecting with it. So a
 * ceiling left behind after the collection goes away does not merely linger, it
 * REPLACES a narrower viewer preference — an escalated contest cap including R
 * outliving the post that carried it, for a viewer who never opted in.
 *
 * The truthy guard this pins the absence of looks protective and is not. Do not
 * restore it: with it, the only way the cap ever drops is a full remount.
 */
describe('a post ceiling is cleared when the post has none', () => {
  const postDetail = () => read('..', '..', 'Post', 'Detail', 'PostDetail.tsx');

  it('sets the cap unconditionally', () => {
    expect(postDetail()).toContain('setForcedBrowsingLevel?.(forcedBrowsingLevel);');
  });

  it('does not skip the call when there is no ceiling', () => {
    expect(
      postDetail().includes('if (forcedBrowsingLevel) {'),
      'guarding the set means a stale ceiling outlives the collection that set it'
    ).toBe(false);
  });
});
