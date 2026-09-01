import { describe, expect, it } from 'vitest';
import { isSortAvailable, resolveFeedSort } from '~/components/Filters/sort-availability';
import { ImageSort, ImageSortHidden, ModelSort } from '~/server/common/enums';

// The three availabilities the rule distinguishes. `.green` is the domain that
// withholds Newest and Oldest outright; SFW-by-choice withholds Newest on the
// images feed alone; a moderator is offered everything.
const green = { isModerator: false, canViewNsfw: false, showNsfw: false };
const sfwByChoice = { isModerator: false, canViewNsfw: true, showNsfw: false };
const moderator = { isModerator: true, canViewNsfw: false, showNsfw: false };

describe('resolveFeedSort', () => {
  it('replaces a sort the menu withholds, on every image-bearing feed', () => {
    for (const type of ['images', 'videos', 'modelImages'] as const) {
      expect(resolveFeedSort({ type, value: ImageSort.Newest }, green)).toBe(
        ImageSort.MostReactions
      );
      expect(resolveFeedSort({ type, value: ImageSort.Oldest }, green)).toBe(
        ImageSort.MostReactions
      );
    }
  });

  it('leaves a sort the menu offers alone', () => {
    expect(resolveFeedSort({ type: 'images', value: ImageSort.MostReactions }, green)).toBe(
      ImageSort.MostReactions
    );
    expect(resolveFeedSort({ type: 'images', value: ImageSort.Newest }, moderator)).toBe(
      ImageSort.Newest
    );
    // Oldest survives SFW-by-choice: that half of the rule is about a freshly
    // posted image, and an oldest-first feed does not front one.
    expect(resolveFeedSort({ type: 'images', value: ImageSort.Oldest }, sfwByChoice)).toBe(
      ImageSort.Oldest
    );
  });

  it('does not touch a feed that is not made of images', () => {
    // The control for the loop above: `isSortAvailable` withholds Newest from
    // these types too, so an unscoped resolver would rewrite them and this is the
    // only assertion that would catch it.
    expect(isSortAvailable({ type: 'models', value: ModelSort.Newest }, green)).toBe(false);
    expect(resolveFeedSort({ type: 'models', value: ModelSort.Newest }, green)).toBe(
      ModelSort.Newest
    );
    expect(resolveFeedSort({ type: 'threads', value: 'Newest' }, green)).toBe('Newest');
  });

  it('never returns a sort the menu would hide', () => {
    // The property the whole thing exists for, over every images sort the menu
    // can offer and all three availabilities.
    const hidden = Object.values(ImageSortHidden);
    const sorts = Object.values(ImageSort).filter((s) => !hidden.includes(s));
    expect(sorts).toHaveLength(5);

    for (const availability of [green, sfwByChoice, moderator]) {
      for (const value of sorts) {
        const resolved = resolveFeedSort({ type: 'images', value }, availability);
        expect(isSortAvailable({ type: 'images', value: resolved }, availability)).toBe(true);
      }
    }
  });
});
