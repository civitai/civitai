import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  submitTrackLyricsScan,
  TRACK_LYRICS_ENTITY_TYPE,
} from '~/server/services/audio-scan/track-lyrics';
import { holdSongForCsam } from '~/server/services/csam-image-review';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { MediaType } from '~/shared/utils/prisma/enums';

// Both dynamic imports below: large graphs the moderation registry should not load.
async function decideSong(imageId: number) {
  const { applySongLyricsVerdict } = await import('~/server/services/audio-scan/apply-song-scan');
  await applySongLyricsVerdict(imageId);
}

async function removeHeldSongFromSearch(imageId: number) {
  // A detection on text a moderator already ruled on writes no hold.
  // primary: the hold was written by this detection
  const held = await dbWrite.textScanHold.findFirst({
    where: {
      entityType: TRACK_LYRICS_ENTITY_TYPE,
      label: 'csam',
      entityId: imageId,
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
 * A song's lyrics: their verdict, from the text scan or XGuard, is what a song with lyrics waits on to
 * go public. A text-scan csam detection is held for a moderator, flags the song for csam review and
 * takes it out of search.
 */
export const trackLyricsModerationAdapter: ModerationAdapter = {
  // A song without lyrics resolves to its title, which is scanned alone, so the row is not dropped.
  resolveContent: async (ids) => {
    const rows = await dbRead.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true },
    });
    const content = new Map(rows.map((row) => [row.imageId, row.text]));
    const withoutLyrics = ids.filter((id) => !content.has(id));
    if (!withoutLyrics.length) return content;
    const songs = await dbRead.image.findMany({
      where: { id: { in: withoutLyrics }, type: MediaType.audio },
      select: { id: true, metadata: true },
    });
    for (const song of songs) {
      const title = (song.metadata as { title?: unknown } | null)?.title;
      if (typeof title === 'string' && title.trim()) content.set(song.id, title);
    }
    return content;
  },

  // Only the retry cron calls submit.
  submit: ({ entityId }) => submitTrackLyricsScan({ imageId: entityId, fromRetry: true }),

  applyFailure: async ({ entityId }) => {
    await decideSong(entityId);
  },

  // XGuard's verdict, while the text scan is off or in shadow for the lyrics: a block blocks the song.
  applyResult: async ({ entityId }) => {
    await decideSong(entityId);
  },

  applyTextScan: withCsamHold(
    'TrackLyrics',
    async ({ entityId, outcome }) => {
      if (outcome.csam?.detected) await removeHeldSongFromSearch(entityId);
      await decideSong(entityId);
    },
    {
      onPendingHold: (tx, { entityId, holdId }) =>
        holdSongForCsam(tx, entityId, { lyrics: holdId }),
    }
  ),
};
