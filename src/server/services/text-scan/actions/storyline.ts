import type { Prisma } from '@prisma/client';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';

export const STORYLINE_TITLE_MODERATED = 'storyline-title-moderated';

/**
 * Clears the scan's takedown, and the storyline's with it unless a moderator holds one too. Two
 * writes because the second flag decides the first; each is conditional on the flags it read.
 */
export async function liftScanTakedown(
  id: number,
  extra: { where?: Prisma.StorylineWhereInput; data?: Prisma.StorylineUpdateManyMutationInput } = {}
) {
  const [alone, underModerator] = await Promise.all([
    dbWrite.storyline.updateMany({
      where: { ...extra.where, id, tosViolationByScan: true, tosViolationByModerator: false },
      data: { ...extra.data, tosViolation: false, tosViolationByScan: false },
    }),
    dbWrite.storyline.updateMany({
      where: { ...extra.where, id, tosViolationByScan: true, tosViolationByModerator: true },
      data: { ...extra.data, tosViolationByScan: false },
    }),
  ]);
  return alone.count + underModerator.count;
}

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
 * The scan's mark is recorded even over a moderator's takedown, and its lift never clears theirs:
 * each holds a takedown of its own, and the storyline is down while either does.
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

  // Either label finding something takes it down; lifting needs both to have answered clean.
  if (outcome.poi?.detected || outcome.minor?.detected) {
    // Not again over the scan's own takedown, nor for text a moderator has cleared.
    const { count } = await dbWrite.storyline.updateMany({
      where: {
        id: entityId,
        tosViolationByScan: false,
        OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: textHash } }],
      },
      data: { tosViolation: true, tosViolationByScan: true },
    });
    if (count) await notifyOwner(before, { storylineId: entityId, takenDown: true }, workflowId);
  } else if (outcome.poi && outcome.minor) {
    await liftScanTakedown(entityId);
  }
}
