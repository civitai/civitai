import { isSong } from './song-card';

/** One removal a queue card offers, posted to the queue's `?/block` with `hidden`. */
export type CardRemoval = {
  kind: 'image' | 'song' | 'cover';
  label: string;
  hidden: Record<string, number>;
};

/**
 * The removals a queue card offers. A song and its cover are separate rows, removed apart: "Remove
 * song" takes the card's report with it, "Remove cover" (only while the song has a cover to remove,
 * `songCoverId`) posts the cover alone, since the report is on the song and its verdict is not this.
 * Any other card keeps its one "Remove".
 */
export function cardRemovals(
  item: { id: number; type?: string | null; songCoverId?: number | null },
  reportId?: number
): CardRemoval[] {
  const hidden: Record<string, number> = reportId
    ? { imageId: item.id, reportId }
    : { imageId: item.id };
  if (!isSong(item)) return [{ kind: 'image', label: 'Remove', hidden }];
  return [
    { kind: 'song', label: 'Remove song', hidden },
    ...(item.songCoverId
      ? [{ kind: 'cover' as const, label: 'Remove cover', hidden: { imageId: item.songCoverId } }]
      : []),
  ];
}

/** The link a cover's card carries back to its song. */
export const coverOfSongLabel = (song: { songId: number; title: string | null }) =>
  `Cover of song ${song.title || `#${song.songId}`}`;
