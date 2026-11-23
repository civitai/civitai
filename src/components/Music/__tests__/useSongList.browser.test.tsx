import { describe, expect, test } from 'vitest';
import { feedAddonFilters } from '~/components/Image/image.utils';
import { songListInput } from '~/components/Music/useSongList';
import { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Every music list reads songs through `useSongList`: what it sends decides whether a list holds
 * songs only, and whether the viewer's excluded tags apply.
 */

const settings = { excludedTagIds: [99], disablePoi: true, disableMinor: true };
const filters = { userId: 42, browsingLevel: 1 };
const input = (viewer: { id: number; username: string }) =>
  songListInput(filters, feedAddonFilters(viewer, settings, filters));

describe('what a song list asks the image feed for', () => {
  test('songs only, with the viewer’s addon filters', () => {
    expect(input({ id: 7, username: 'listener' })).toMatchObject({
      types: [MediaType.audio],
      excludedTagIds: [99],
      disablePoi: true,
      disableMinor: true,
    });
  });

  test('the viewer’s own songs skip their excluded tags', () => {
    expect(input({ id: 42, username: 'artist' }).excludedTagIds).toEqual([]);
  });
});
