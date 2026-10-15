import type { Prisma } from '@prisma/client';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { storylineTextScanSubject } from '~/server/services/text-scan/profiles/storyline.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';

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

/** `source` keys the notice: one per scan verdict, or per moderator action. */
export const notifyStorylineTitleModerated = (
  storyline: { userId: number; title: string },
  details: { storylineId: number; level?: number; takenDown?: true; minor?: true },
  source: string
) =>
  createNotification({
    userId: storyline.userId,
    category: NotificationCategory.System,
    type: STORYLINE_TITLE_MODERATED,
    // Per verdict: a redelivered callback is the same notice, a later scan is a new one.
    key: `${STORYLINE_TITLE_MODERATED}-${details.storylineId}-${
      details.takenDown ? 'tos' : details.minor ? 'minor' : details.level
    }-${source}`,
    details: { ...details, title: storyline.title },
  });

/**
 * nsfw sets the title's rating, which only ever narrows who is shown the story (the higher of it
 * and chapter 1's level). A person of interest takes the storyline down, and so does a minor with
 * an NSFW title (R or above, by the higher of a moderator's rating and this verdict's). A minor
 * with a safe title does not: it sets `minorByScan`, which holds every chapter to safe for work
 * (`storylineCeiling`) and is cleared by a clean minor verdict.
 *
 * Fail closed: a minor finding with no rating to judge the title by takes it down, and a lift
 * needs poi and minor both answered. The scan's takedown is marked as its own, recorded even over
 * a moderator's takedown, and its lift never clears theirs.
 */
export async function applyStorylineTextScan({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs) {
  const before = await dbWrite.storyline.findUnique({
    where: { id: entityId },
    select: {
      userId: true,
      title: true,
      nsfwLevel: true,
      moderatorNsfwLevel: true,
    },
  });
  if (!before) return;
  // A verdict on text the title no longer has (it was edited after the scan was sent) may only
  // restrict: take down, mark a minor, raise the rating. It never lifts, clears or lowers; the
  // scan of the current title, which the edit started, settles those.
  const current =
    textHash ===
    textScanTextHash(storylineTextScanSubject({ userId: before.userId, title: before.title }));

  if (outcome.nsfw && (current || outcome.nsfw.detectedLevel > before.nsfwLevel)) {
    const level = outcome.nsfw.detectedLevel;
    // A lower rating is permissive, so it also holds only while the title is still the one read.
    const pinned = level <= before.nsfwLevel ? { title: before.title } : {};
    await dbWrite.storyline.updateMany({
      where: { id: entityId, ...pinned },
      data: { nsfwLevel: level },
    });
    // A moderator's ruling stands in for the scan's, so a changed scan level changes nothing.
    if (level >= NsfwLevel.R && level > before.nsfwLevel && before.moderatorNsfwLevel == null)
      await notifyStorylineTitleModerated(before, { storylineId: entityId, level }, workflowId);
  }

  // The higher of a moderator's rating and this verdict's: a rating is not tied to the text it
  // was given for, so after the title is edited it must not vouch for a new one. A moderator who
  // disagrees lifts the takedown for the title they reviewed (`moderateStorylineTitle`).
  const ratings = [before.moderatorNsfwLevel, outcome.nsfw?.detectedLevel].filter(
    (level): level is number => level != null
  );
  const titleLevel = ratings.length ? Math.max(...ratings) : null;
  const minor = !!outcome.minor?.detected;
  const takeDown =
    !!outcome.poi?.detected || (minor && (titleLevel == null || titleLevel >= NsfwLevel.R));

  // Only an answered minor label moves the flag: a missing one leaves it as it was. Written before
  // any lift below, so a storyline coming back up is never shown uncapped, even if a write fails.
  if (outcome.minor && (current || minor)) {
    const { count } = await dbWrite.storyline.updateMany({
      // Clearing is permissive: only while the title is still the one this verdict judged.
      where: { id: entityId, minorByScan: !minor, ...(!minor && { title: before.title }) },
      data: { minorByScan: minor },
    });
    if (count && minor && !takeDown)
      await notifyStorylineTitleModerated(
        before,
        { storylineId: entityId, minor: true },
        workflowId
      );
  }

  if (takeDown) {
    // Not again over the scan's own takedown, nor for text a moderator has cleared. Keep this
    // write unconditional otherwise: a clean minor answer above may have just lifted the cap, and a
    // person of interest must still take the storyline down.
    const { count } = await dbWrite.storyline.updateMany({
      where: {
        id: entityId,
        tosViolationByScan: false,
        OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: textHash } }],
      },
      data: { tosViolation: true, tosViolationByScan: true },
    });
    if (count)
      await notifyStorylineTitleModerated(
        before,
        { storylineId: entityId, takenDown: true },
        workflowId
      );
  } else if (current && outcome.poi && outcome.minor) {
    // Pinned to the title read above: a rename landing mid-apply leaves the lift to its own scan.
    await liftScanTakedown(entityId, { where: { title: before.title } });
  }
}
