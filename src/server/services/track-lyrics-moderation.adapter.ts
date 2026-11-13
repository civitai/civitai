import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { SONG_LYRICS_HOLD } from '~/server/common/image-visibility';
import { submitTrackLyricsScan } from '~/server/services/audio-scan/track-lyrics';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';

// Both dynamic imports below: large graphs the moderation registry should not load.
async function decideSong(imageId: number) {
  const { applySongLyricsVerdict } = await import('~/server/services/audio-scan/apply-song-scan');
  await applySongLyricsVerdict(imageId);
}

async function removeHeldSongFromSearch(imageId: number) {
  // A detection on text a moderator already ruled on writes no hold.
  const held = await dbWrite.textScanHold.findFirst({
    where: { ...SONG_LYRICS_HOLD, entityId: imageId, status: 'Pending' },
    select: { id: true },
  });
  if (!held) return;
  const { queueImageSearchIndexUpdate } = await import('~/server/services/image.service');
  await queueImageSearchIndexUpdate({
    ids: [imageId],
    action: SearchIndexUpdateQueueAction.Delete,
  });
}

/**
 * A song's lyrics: their text-scan verdict is what a song with lyrics waits on to go public. A csam
 * detection is held for a moderator and the held song leaves search.
 */
export const trackLyricsModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true },
    });
    return new Map(rows.map((row) => [row.imageId, row.text]));
  },

  // Only the retry cron calls submit.
  submit: ({ entityId }) => submitTrackLyricsScan({ imageId: entityId, fromRetry: true }),

  applyFailure: async ({ entityId }) => {
    await decideSong(entityId);
  },

  applyTextScan: withCsamHold('TrackLyrics', async ({ entityId, outcome }) => {
    if (outcome.csam?.detected) await removeHeldSongFromSearch(entityId);
    await decideSong(entityId);
  }),
};
