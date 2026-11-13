import { SONG_LYRICS_MAX_LENGTH } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { toSubmittedWorkflow } from '~/server/services/text-scan/route';
import { scanEntity } from '~/server/services/text-scan/submit';
import { parseLyricLines } from '~/shared/form-graph/generation/audio/song-metadata';
import { EntityModerationStatus, TrackLyricsSource } from '~/shared/utils/prisma/enums';

export const TRACK_LYRICS_ENTITY_TYPE = 'TrackLyrics';

/** Cuts text over the cap at its last whole line; a single line past the cap is cut where it hits. */
function capLyrics(text: string) {
  if (text.length <= SONG_LYRICS_MAX_LENGTH) return text;
  const head = text.slice(0, SONG_LYRICS_MAX_LENGTH + 1);
  const lastBreak = head.lastIndexOf('\n');
  return lastBreak > 0 ? head.slice(0, lastBreak) : head.slice(0, SONG_LYRICS_MAX_LENGTH);
}

/** Saves the lyrics a song was generated from, untimed. Nothing is saved for text with no lines. */
export async function saveGeneratedTrackLyrics({
  imageId,
  text: rawText,
}: {
  imageId: number;
  text: string | undefined;
}) {
  const text = rawText === undefined ? undefined : capLyrics(rawText);
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

/** Sends a song's lyrics to the text scan, the only scan that gives them a verdict. */
export async function submitTrackLyricsScan({
  imageId,
  fromRetry,
}: {
  imageId: number;
  fromRetry?: boolean;
}) {
  return toSubmittedWorkflow(
    await scanEntity({ entityType: TRACK_LYRICS_ENTITY_TYPE, entityId: imageId, fromRetry })
  );
}

/**
 * Sends a song's lyrics, throwing when no verdict will come so the song's capped retry counts the
 * attempt. Only an active scan's verdict reaches the song; a shadow one is recorded apart.
 */
export async function sendTrackLyricsScan(imageId: number) {
  const active = (await getTextScanMode(TRACK_LYRICS_ENTITY_TYPE, imageId)) === 'active';
  const workflow = active ? await submitTrackLyricsScan({ imageId }) : null;
  if (!workflow?.id) throw new Error('lyrics scan not sent: the text scan is off or skipped them');
}

export type LyricsVerdict =
  | { state: 'none' }
  /** `failed`: the last scan ended without a verdict; neither it nor `inFlight` means never sent. */
  | { state: 'pending'; inFlight: boolean; failed: boolean }
  | { state: 'scanned' };

/** Where a song's lyrics verdict stands; `none` for a song without lyrics. */
export async function readLyricsVerdict(imageId: number): Promise<LyricsVerdict> {
  const lyrics = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { imageId: true },
  });
  if (!lyrics) return { state: 'none' };
  const moderation = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: TRACK_LYRICS_ENTITY_TYPE, entityId: imageId } },
    select: { status: true },
  });
  if (moderation?.status === EntityModerationStatus.Succeeded) return { state: 'scanned' };
  return {
    state: 'pending',
    inFlight: moderation?.status === EntityModerationStatus.Pending,
    failed: !!moderation && moderation.status !== EntityModerationStatus.Pending,
  };
}
