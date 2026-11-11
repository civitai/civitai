import { dbWrite } from '~/server/db/client';
import { parseLyricLines } from '~/shared/form-graph/generation/audio/song-metadata';
import { TrackLyricsSource } from '~/shared/utils/prisma/enums';

/** Saves the lyrics a song was generated from, untimed. Nothing is saved for text with no lines. */
export async function saveGeneratedTrackLyrics({
  imageId,
  text,
}: {
  imageId: number;
  text: string | undefined;
}) {
  const lines = parseLyricLines(text);
  if (!text || !lines) return false;
  const data = { text, lines, source: TrackLyricsSource.generator };
  await dbWrite.trackLyrics.upsert({
    where: { imageId },
    create: { imageId, ...data },
    update: data,
  });
  return true;
}

export async function hasTrackLyrics(imageId: number) {
  const row = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { imageId: true },
  });
  return !!row;
}
