import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';

export const STORYLINE_TITLE_MODERATED = 'storyline-title-moderated';

const notifyOwner = (
  storyline: { userId: number; title: string },
  details: { storylineId: number; level?: number; takenDown?: true },
  workflowId: string
) =>
  createNotification({
    userId: storyline.userId,
    category: NotificationCategory.System,
    type: STORYLINE_TITLE_MODERATED,
    // Per verdict: a redelivered callback is the same notice, a later scan is a new one.
    key: `${STORYLINE_TITLE_MODERATED}-${details.storylineId}-${
      details.takenDown ? 'tos' : details.level
    }-${workflowId}`,
    details: { ...details, title: storyline.title },
  });

/**
 * nsfw sets the title's rating, which only ever narrows who is shown the story (the higher of it
 * and chapter 1's level); the ceiling on chapters is the owner's and is left alone. poi or minor
 * takes the storyline down, marked as the scan's, so a clean scan of an edited title lifts it.
 */
export async function applyStorylineTextScan({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs) {
  const before = await dbWrite.storyline.findUnique({
    where: { id: entityId },
    select: { userId: true, title: true, nsfwLevel: true, moderatorNsfwLevel: true },
  });
  if (!before) return;

  if (outcome.nsfw) {
    const level = outcome.nsfw.detectedLevel;
    await dbWrite.storyline.updateMany({ where: { id: entityId }, data: { nsfwLevel: level } });
    // A moderator's ruling stands in for the scan's, so a changed scan level changes nothing.
    if (level >= NsfwLevel.R && level > before.nsfwLevel && before.moderatorNsfwLevel == null)
      await notifyOwner(before, { storylineId: entityId, level }, workflowId);
  }

  // Both labels must have answered before a takedown is lifted.
  if (!outcome.poi || !outcome.minor) return;
  if (outcome.poi.detected || outcome.minor.detected) {
    // Never over a takedown already in place, and not again for text a moderator has cleared.
    const { count } = await dbWrite.storyline.updateMany({
      where: {
        id: entityId,
        tosViolation: false,
        OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: textHash } }],
      },
      data: { tosViolation: true, tosViolationByScan: true },
    });
    if (count) await notifyOwner(before, { storylineId: entityId, takenDown: true }, workflowId);
  } else {
    await dbWrite.storyline.updateMany({
      where: { id: entityId, tosViolationByScan: true },
      data: { tosViolation: false, tosViolationByScan: false },
    });
  }
}
