/**
 * What a creator sees while a training run waits on review, shared by the classic trainer (main
 * app) and Training Studio so the two never promise different waits. Status only: the copy says
 * that a run is waiting and how long that usually takes, never what the review looks at.
 */

/** The wait the copy promises. Every string that states the wait reads it from here. */
export const TRAINING_REVIEW_EXPECTED_WAIT = 'Usually within a day, 48 hours at most';

/** How long a run is held, in hours of real time, before the creator is offered a way to raise it. */
export const TRAINING_REVIEW_RAISE_AFTER_HOURS = 24;

const HOUR_MS = 3_600_000;

/** When the hold began: the step's start, else the workflow's creation (the run is held at submit). */
export function trainingHeldSince(
  stepStartedAt: string | null | undefined,
  createdAt: string | null | undefined
): string | null {
  return stepStartedAt || createdAt || null;
}

/** Whether a run held since `heldSince` has waited long enough to be raised. False for a bad date. */
export function canRaiseTrainingReview(
  heldSince: string | Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (!heldSince) return false;
  const start = new Date(heldSince).getTime();
  if (Number.isNaN(start)) return false;
  return now.getTime() - start >= TRAINING_REVIEW_RAISE_AFTER_HOURS * HOUR_MS;
}

/** The training step's review state, as either orchestrator API spells it (`underReview` / `UnderReview`). */
export function trainingReviewState(moderationStatus: unknown): 'review' | 'rejected' | null {
  if (typeof moderationStatus !== 'string') return null;
  const s = moderationStatus.toLowerCase();
  if (s === 'underreview') return 'review';
  if (s === 'rejected') return 'rejected';
  return null;
}

export const TRAINING_REVIEW_COPY = {
  pendingLabel: 'Pending review',
  pendingTitle: 'Waiting for review',
  pendingBody: `This run is waiting for review before it starts training. ${TRAINING_REVIEW_EXPECTED_WAIT}. No action is needed from you while it waits.`,
  pendingPartwayBody: `This run is paused for review partway through training. ${TRAINING_REVIEW_EXPECTED_WAIT}. No action is needed from you while it waits.`,
  pendingFinishedBody: `Training has finished, and this run is waiting for review before it completes. ${TRAINING_REVIEW_EXPECTED_WAIT}. No action is needed from you while it waits.`,
  raiseBody: "Still waiting? You can raise it with support. Include this run's ID in your ticket.",
  contactSupport: 'Contact support',
  notApprovedLabel: 'Not approved',
  notApprovedTitle: 'Not approved in review',
  notApprovedBody: 'This run was not approved in review, so it did not train.',
  unreviewedLabel: 'Not reviewed in time',
  unreviewedTitle: 'Not reviewed in time',
  unreviewedBody:
    'This run was not reviewed in time, so it did not train. You can submit it again.',
} as const;

/** The pending-review body for where the hold caught the run: the gate holds runs at submit and
 *  after their last epoch, so "before it starts training" is only true with no checkpoints yet. */
export function trainingReviewPendingBody(
  completedEpochs: number,
  plannedEpochs: number | null | undefined
): string {
  if (completedEpochs <= 0) return TRAINING_REVIEW_COPY.pendingBody;
  if (plannedEpochs && completedEpochs >= plannedEpochs)
    return TRAINING_REVIEW_COPY.pendingFinishedBody;
  return TRAINING_REVIEW_COPY.pendingPartwayBody;
}
