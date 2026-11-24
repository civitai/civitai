import type { MediaType } from '$lib/media/edge-url';

/** A lyric line: `t` is its offset in milliseconds, or null when the line has no time. The main app
 *  writes it to `lyricLineSchema` (src/server/schema/media.schema.ts); read leniently here. */
export type SongLyricLine = { t: number | null; text: string };

/** What `/api/song-card/[imageId]` answers: everything a song card shows beyond the audio itself. */
export type SongCard = {
  id: number;
  /** The song's storage key, as the Image row's `url`. */
  url: string;
  title: string | null;
  /** From the upload's metadata; the card reads the file's own once it loads. */
  durationSec: number | null;
  /** Null shows the placeholder: no cover, or one the public player would not show. */
  cover: { id: number; url: string } | null;
  lines: SongLyricLine[];
};

export const songCardUrl = (imageId: number) => `/api/song-card/${imageId}`;

/** A queue item that renders as a song card rather than an image or video. */
export const isSong = (item: { type?: MediaType | string | null }) => item.type === 'audio';

/** Whether a card offers the Minor and POI flags: never on a song, which shows no person. */
export const offersImageFlags = (item: { type?: MediaType | string | null }) => !isSong(item);
