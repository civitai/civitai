import { describe, expect, it } from 'vitest';
import { cardRemovals, coverOfSongLabel, shownCover } from '$lib/music/song-tos';

/**
 * The removals a queue card offers (Music T10 item 2, docs/features/music.md "Moderating songs"): a
 * song card removes the song and, apart from it, its cover; every other card is unchanged.
 */

describe('cardRemovals', () => {
  it('offers an image card one Remove, carrying its report', () => {
    expect(cardRemovals({ id: 5, type: 'image', songCoverId: null }, 9)).toEqual([
      { kind: 'image', label: 'Remove', hidden: { imageId: 5, reportId: 9 } },
    ]);
    expect(cardRemovals({ id: 5, type: 'video' })).toEqual([
      { kind: 'image', label: 'Remove', hidden: { imageId: 5 } },
    ]);
  });

  it('offers a song card "Remove song" and "Remove cover", the cover without the song\'s report', () => {
    expect(cardRemovals({ id: 20, type: 'audio', songCoverId: 120 }, 9)).toEqual([
      { kind: 'song', label: 'Remove song', hidden: { imageId: 20, reportId: 9 } },
      { kind: 'cover', label: 'Remove cover', hidden: { imageId: 120 } },
    ]);
  });

  it('offers no "Remove cover" on a song with no cover to remove', () => {
    expect(cardRemovals({ id: 20, type: 'audio', songCoverId: null })).toEqual([
      { kind: 'song', label: 'Remove song', hidden: { imageId: 20 } },
    ]);
  });
});

describe('coverOfSongLabel', () => {
  it('names the song by its title, or by its id when it has none', () => {
    expect(coverOfSongLabel({ songId: 20, title: 'Night drive' })).toBe(
      'Cover of song Night drive'
    );
    expect(coverOfSongLabel({ songId: 20, title: null })).toBe('Cover of song #20');
  });
});

describe('shownCover', () => {
  const cover = { id: 120, url: 'cover-key' };
  it('drops a cover removed on this page to the placeholder, and keeps any other', () => {
    expect(shownCover(cover, new Set([120]))).toBeNull();
    expect(shownCover(cover, new Set([121]))).toBe(cover);
    expect(shownCover(null, new Set([120]))).toBeNull();
  });
});
