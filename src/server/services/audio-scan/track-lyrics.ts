import { SONG_LYRICS_MAX_LENGTH } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import {
  TRACK_LYRICS_ENTITY_TYPE,
  TRACK_LYRICS_LANGUAGE_ENTITY_TYPE,
} from '~/server/services/audio-scan/song-rating';
import {
  submitProfanityModeration,
  submitTextModeration,
} from '~/server/services/text-moderation.service';
import {
  submitTextModerationOrScan,
  TEXT_SCAN_ENTITY_GONE,
} from '~/server/services/text-scan/route';
import { parseLyricLines } from '~/shared/form-graph/generation/audio/song-metadata';
import { EntityModerationStatus, TrackLyricsSource } from '~/shared/utils/prisma/enums';

export { TRACK_LYRICS_ENTITY_TYPE };

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

/**
 * Sends a song's lyrics, and its title, for their verdict: the text scan while it is active for
 * them, XGuard otherwise, so a verdict always comes for lyrics. A song with a title and no lyrics
 * gets the text scan only; XGuard rates nothing, so it sends nothing then.
 */
export async function submitTrackLyricsScan({
  imageId,
  fromRetry,
}: {
  imageId: number;
  fromRetry?: boolean;
}) {
  return submitTextModerationOrScan({
    entityType: TRACK_LYRICS_ENTITY_TYPE,
    entityId: imageId,
    fromRetry,
    // No lyrics and no title left (a cleared title): an old title verdict must stop rating the song.
    onActiveSkip: async (reason) => {
      if (reason === 'missing')
        await dbWrite.entityModeration.deleteMany({
          where: { entityType: TRACK_LYRICS_ENTITY_TYPE, entityId: imageId },
        });
    },
    xguard: async () => {
      // primary: the lyrics are written just before their scan is submitted
      const lyrics = await dbWrite.trackLyrics.findUnique({
        where: { imageId },
        select: { text: true },
      });
      if (!lyrics) return TEXT_SCAN_ENTITY_GONE;
      return submitTextModeration({
        entityType: TRACK_LYRICS_ENTITY_TYPE,
        entityId: imageId,
        content: lyrics.text,
        rearmRetries: !fromRetry,
      });
    },
  });
}

/**
 * Sends a song's lyrics for their language level (`TrackLyricsLanguage`), which raises the song's
 * rating (`songLevel`). The song never waits on it: a null level is not rated, never clean.
 */
export async function submitTrackLyricsLanguageScan({
  imageId,
  fromRetry,
}: {
  imageId: number;
  fromRetry?: boolean;
}) {
  // primary: the lyrics are written just before their scan is submitted
  const lyrics = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { text: true },
  });
  if (!lyrics) return TEXT_SCAN_ENTITY_GONE;
  return submitProfanityModeration({
    entityType: TRACK_LYRICS_LANGUAGE_ENTITY_TYPE,
    entityId: imageId,
    content: lyrics.text,
    rearmRetries: !fromRetry,
  });
}

/** Sends a song's lyrics, throwing when no verdict will come so the song's capped retry counts the attempt. */
export async function sendTrackLyricsScan(imageId: number) {
  const workflow = await submitTrackLyricsScan({ imageId });
  if (!workflow?.id) throw new Error('lyrics scan not sent: it was skipped or failed to submit');
}

export type LyricsVerdict =
  | { state: 'none' }
  /** `failed`: the last scan ended without a verdict; neither it nor `inFlight` means never sent. */
  | { state: 'pending'; inFlight: boolean; failed: boolean }
  /** `blocked`: XGuard blocked them; a text-scan verdict never blocks. */
  | { state: 'scanned'; blocked: boolean };

/** Where a song's lyrics verdict stands; `none` for a song without lyrics. */
export async function readLyricsVerdict(imageId: number): Promise<LyricsVerdict> {
  // primary: decides a song right after its lyrics are written
  const lyrics = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { imageId: true },
  });
  if (!lyrics) return { state: 'none' };
  // primary: the verdict may have just been written by its callback
  const moderation = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: TRACK_LYRICS_ENTITY_TYPE, entityId: imageId } },
    select: { status: true, blocked: true },
  });
  if (moderation?.status === EntityModerationStatus.Succeeded)
    return { state: 'scanned', blocked: moderation.blocked === true };
  return {
    state: 'pending',
    inFlight: moderation?.status === EntityModerationStatus.Pending,
    failed: !!moderation && moderation.status !== EntityModerationStatus.Pending,
  };
}
