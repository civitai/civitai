import type { MantineColor } from '@mantine/core';
import { TRAINING_REVIEW_EXPECTED_WAIT } from '@civitai/shared/training-review';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

export const trainingStatusFields: {
  [key in TrainingStatus]: { color: MantineColor; description: string };
} = {
  [TrainingStatus.Pending]: {
    color: 'yellow',
    description:
      'The model has not yet been submitted for training. Important info, like a dataset, may still need to be uploaded.',
  },
  [TrainingStatus.Submitted]: {
    color: 'blue',
    description:
      'A request to train has been submitted, and will soon be actively processing. You will be emailed when it is complete.',
  },
  [TrainingStatus.Paused]: {
    color: 'orange',
    // Stage-neutral: the gate holds runs at submit and after their last epoch, and this map has
    // no epoch count to tell which.
    description: `This run is waiting for review. ${TRAINING_REVIEW_EXPECTED_WAIT}. No action is needed from you while it waits.`,
  },
  [TrainingStatus.Denied]: {
    color: 'red',
    description:
      'We have found an issue with the training dataset that may violate the TOS. This request has been rejected - please contact us with any questions.',
  },
  [TrainingStatus.Processing]: {
    color: 'teal',
    description:
      'The training job is actively processing. In other words: the model is baking. You will be emailed when it is complete.',
  },
  [TrainingStatus.InReview]: {
    color: 'green',
    description:
      'Training is complete, and your resulting model files are ready to be reviewed and published.',
  },
  [TrainingStatus.Approved]: {
    color: 'green',
    description:
      'Training is complete, and you have selected an Epoch. You may click here to continue the publishing setup.',
  },
  [TrainingStatus.Failed]: {
    color: 'red',
    description:
      'Something went wrong with the training request. Recreate the training job if you see this error (or contact us for help).',
  },
  [TrainingStatus.Expired]: {
    color: 'orange',
    description:
      'The training data review was not completed in time and this request has expired. Please submit your training again.',
  },
};

/**
 * A dataset is fixed once training has started, so the run's results and its review describe the
 * bytes on record. Before the first run, and after a run that failed or expired (a retry), a new
 * dataset may be uploaded. A denied dataset is never replaced.
 */
export const datasetEditableTrainingStatuses: (TrainingStatus | null)[] = [
  null,
  TrainingStatus.Pending,
  TrainingStatus.Failed,
  TrainingStatus.Expired,
];
export const isDatasetEditable = (status: TrainingStatus | null | undefined) =>
  datasetEditableTrainingStatuses.includes(status ?? null);

/** A dataset under moderator review, or denied, stays on record: only a moderator may delete it. */
export const reviewedDatasetTrainingStatuses: TrainingStatus[] = [
  TrainingStatus.Paused,
  TrainingStatus.Denied,
];

/**
 * A run reads its dataset, and an InReview run is published from it, so the owner can't delete it
 * meanwhile. Keyed on the version: a new version can train on an already-published model.
 */
export const liveRunDatasetTrainingStatuses: TrainingStatus[] = [
  TrainingStatus.Submitted,
  TrainingStatus.Processing,
  TrainingStatus.InReview,
];

/** A run in progress or under moderation keeps its version: the owner can't delete it or merge it away. */
export const versionRemovalLockedTrainingStatuses: TrainingStatus[] = [
  TrainingStatus.Submitted,
  TrainingStatus.Processing,
  TrainingStatus.Paused,
  TrainingStatus.Denied,
];

/**
 * The classic trainer (/models/train) stops starting runs at this instant; Training Studio is
 * unaffected. The banners quote it, so change it only alongside the announcement.
 */
export const CLASSIC_TRAINER_RETIRES_AT = new Date('2026-11-16T00:00:00Z');
export const isClassicTrainerRetired = (now = new Date()) => now >= CLASSIC_TRAINER_RETIRES_AT;
export const CLASSIC_TRAINER_RETIRED_MESSAGE =
  'The classic trainer has been retired and no longer starts new runs. Use Training Studio to train.';
