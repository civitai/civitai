import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { TRACK_LYRICS_LANGUAGE_ENTITY_TYPE } from '~/server/services/audio-scan/song-rating';
import { submitTrackLyricsLanguageScan } from '~/server/services/audio-scan/track-lyrics';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';

/** XGuard's `languageLevel` (0 none, 1 mild or moderate, 2 strong) as a rating; null is unrated. */
const LANGUAGE_RATINGS: Record<number, number> = {
  0: NsfwLevel.PG,
  1: NsfwLevel.PG13,
  2: NsfwLevel.R,
};

/**
 * A song's lyrics profanity (`mode: 'profanity'`): its rating is stored on its own EntityModeration
 * row and raises the song's level (`songLevel`). It never blocks, and the song never waits on it.
 */
export const trackLyricsLanguageModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true },
    });
    return new Map(rows.map((row) => [row.imageId, row.text]));
  },

  submit: ({ entityId }) => submitTrackLyricsLanguageScan({ imageId: entityId, fromRetry: true }),

  applyResult: async ({ entityId, workflowId, output }) => {
    const level = output.languageLevel;
    const { count } = await dbWrite.entityModeration.updateMany({
      where: { entityType: TRACK_LYRICS_LANGUAGE_ENTITY_TYPE, entityId, workflowId },
      data: { nsfwLevel: typeof level === 'number' ? LANGUAGE_RATINGS[level] ?? null : null },
    });
    if (!count) return;
    // A large graph the moderation registry should not load.
    const { rerateSong } = await import('~/server/services/image-scan-pipeline');
    await rerateSong(entityId);
  },
};
