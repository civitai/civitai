import { dbWrite } from '~/server/db/client';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { parseLyricLines } from '~/shared/form-graph/generation/audio/song-metadata';
import { EntityModerationStatus, TrackLyricsSource } from '~/shared/utils/prisma/enums';

export const TRACK_LYRICS_ENTITY_TYPE = 'TrackLyrics';

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

/**
 * Sends a song's lyrics for their verdict, which the song waits on to go public. The text scan
 * owns them while active; otherwise, or when it skips them, XGuard does, so a verdict always comes.
 */
export async function submitTrackLyricsScan({
  imageId,
  content,
  fromRetry,
}: {
  imageId: number;
  content: string;
  fromRetry?: boolean;
}) {
  const xguard = () =>
    submitTextModeration({
      entityType: TRACK_LYRICS_ENTITY_TYPE,
      entityId: imageId,
      content,
      labels: ['nsfw'],
      priority: 'low',
    });
  return submitTextModerationOrScan({
    entityType: TRACK_LYRICS_ENTITY_TYPE,
    entityId: imageId,
    fromRetry,
    xguard,
    onActiveSkip: async () => {
      await xguard();
    },
  });
}

export type LyricsVerdict =
  | { state: 'none' }
  | { state: 'pending'; inFlight: boolean; text: string }
  | { state: 'clean' }
  | { state: 'blocked' };

/** Where a song's lyrics verdict stands; `none` for a song without lyrics. */
export async function readLyricsVerdict(imageId: number): Promise<LyricsVerdict> {
  const lyrics = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { text: true },
  });
  if (!lyrics) return { state: 'none' };
  const moderation = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: TRACK_LYRICS_ENTITY_TYPE, entityId: imageId } },
    select: { status: true, blocked: true },
  });
  if (moderation?.status === EntityModerationStatus.Succeeded)
    return { state: moderation.blocked ? 'blocked' : 'clean' };
  return {
    state: 'pending',
    inFlight: moderation?.status === EntityModerationStatus.Pending,
    text: lyrics.text,
  };
}
