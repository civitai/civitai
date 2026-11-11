import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  submitTrackLyricsScan,
  TRACK_LYRICS_ENTITY_TYPE,
} from '~/server/services/audio-scan/track-lyrics';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';

// Imported here: both are large graphs the moderation registry should not load.
async function decideSong(imageId: number) {
  const { applySongLyricsVerdict } = await import('~/server/services/audio-scan/apply-song-scan');
  await applySongLyricsVerdict(imageId);
}

async function removeHeldSongFromSearch(imageId: number) {
  // A detection on text a moderator already ruled on writes no hold.
  const held = await dbWrite.textScanHold.findFirst({
    where: {
      entityType: TRACK_LYRICS_ENTITY_TYPE,
      entityId: imageId,
      label: 'csam',
      status: 'Pending',
    },
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
 * A song's lyrics. Their verdict, from XGuard or the text scan, is what a song with lyrics waits on
 * to go public. A csam detection is held for a moderator and the held song leaves search; the nsfw
 * verdict is recorded but does not rate the song yet.
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
  submit: ({ entityId, content }) =>
    submitTrackLyricsScan({ imageId: entityId, content, fromRetry: true }),

  applyResult: async ({ entityId }) => {
    await decideSong(entityId);
  },

  applyTextScan: withCsamHold('TrackLyrics', async ({ entityId, outcome }) => {
    if (outcome.csam?.detected) await removeHeldSongFromSearch(entityId);
    await decideSong(entityId);
  }),
};
