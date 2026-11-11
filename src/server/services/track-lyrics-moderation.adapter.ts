import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';

/**
 * A song's lyrics. A csam detection is held for a moderator, and the held song leaves search; the
 * nsfw verdict is recorded but does not rate the song yet.
 */
export const trackLyricsModerationAdapter = createTextScanAdapter('TrackLyrics', {
  applyTextScan: withCsamHold('TrackLyrics', async ({ entityId, outcome }) => {
    if (!outcome.csam?.detected) return;
    // A detection on text a moderator already ruled on writes no hold.
    const held = await dbWrite.textScanHold.findFirst({
      where: { entityType: 'TrackLyrics', entityId, label: 'csam', status: 'Pending' },
      select: { id: true },
    });
    if (!held) return;
    // Imported here: image.service is a large graph the moderation registry should not load.
    const { queueImageSearchIndexUpdate } = await import('~/server/services/image.service');
    await queueImageSearchIndexUpdate({
      ids: [entityId],
      action: SearchIndexUpdateQueueAction.Delete,
    });
  }),
});
