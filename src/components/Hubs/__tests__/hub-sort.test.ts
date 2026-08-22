import { describe, expect, it } from 'vitest';
import { isSortAvailable } from '~/components/Filters/sort-availability';
import { resolveHubSort } from '~/components/Hubs/hub-sort';
import { ImageSort } from '~/server/common/enums';

const green = { isModerator: false, canViewNsfw: false, showNsfw: false };
const sfwByChoice = { isModerator: false, canViewNsfw: true, showNsfw: false };
const nsfw = { isModerator: false, canViewNsfw: true, showNsfw: true };
const moderator = { isModerator: true, canViewNsfw: false, showNsfw: false };

describe('resolveHubSort', () => {
  it('keeps the stored sort when the viewer is offered it', () => {
    expect(resolveHubSort(ImageSort.Newest, nsfw)).toBe(ImageSort.Newest);
    expect(resolveHubSort(ImageSort.MostComments, green)).toBe(ImageSort.MostComments);
  });

  it('falls back off a sort the menu hides, so the viewer can get back to it', () => {
    expect(resolveHubSort(ImageSort.Newest, green)).toBe(ImageSort.MostReactions);
    expect(resolveHubSort(ImageSort.Oldest, green)).toBe(ImageSort.MostReactions);
    expect(resolveHubSort(ImageSort.Newest, sfwByChoice)).toBe(ImageSort.Oldest);
  });

  it('leaves a moderator on the stored sort', () => {
    expect(resolveHubSort(ImageSort.Newest, moderator)).toBe(ImageSort.Newest);
  });

  it('resolves an unparseable stored sort through the same fallback', () => {
    expect(resolveHubSort('Most Buzz', nsfw)).toBe(ImageSort.Newest);
    expect(resolveHubSort('Most Buzz', green)).toBe(ImageSort.MostReactions);
  });
});

describe('isSortAvailable', () => {
  it('hides Newest and Oldest from a viewer who cannot view NSFW', () => {
    expect(isSortAvailable({ type: 'images', value: ImageSort.Newest }, green)).toBe(false);
    expect(isSortAvailable({ type: 'images', value: ImageSort.Oldest }, green)).toBe(false);
    expect(isSortAvailable({ type: 'images', value: ImageSort.MostReactions }, green)).toBe(true);
  });

  it('hides only Newest, and only on image sorts, when NSFW is merely switched off', () => {
    expect(isSortAvailable({ type: 'images', value: ImageSort.Newest }, sfwByChoice)).toBe(false);
    expect(isSortAvailable({ type: 'images', value: ImageSort.Oldest }, sfwByChoice)).toBe(true);
    expect(isSortAvailable({ type: 'models', value: 'Newest' }, sfwByChoice)).toBe(true);
  });
});
