// Pencil `AECSM`.
export const SONG_COVER_RATIO = 200 / 213;
/**
 * The Song Card's height below the cover; the feed adds it to the cover height. Its four rows
 * (20 + 16 + 15 + 15), three 6px gaps and 12px padding above and below.
 */
export const SONG_CARD_TEXT_HEIGHT = 108;
/** Pencil `xNZ0Z`. */
export const MUSIC_FEED_COLUMN_WIDTH = 213;
/** Pencil `CaAoU`: 256 there, four across in a body with 24px sides. */
const PROFILE_SONG_MIN_COLUMN_WIDTH = 240;
export const PROFILE_SONG_SIDE_PADDING = 12;

/** The profile Music tab's columns widen from the minimum to fill `width`, flush with the toolbar. */
export function profileSongColumnWidth(width: number, gap = 16) {
  if (width <= 0) return PROFILE_SONG_MIN_COLUMN_WIDTH;
  const count = Math.max(1, Math.floor((width + gap) / (PROFILE_SONG_MIN_COLUMN_WIDTH + gap)));
  return Math.floor((width - (count - 1) * gap) / count);
}
