import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ModelStatus, TrainingStatus } from '~/shared/utils/prisma/enums';

// A version that has been out in the world (or is about to be) keeps its files; new bytes go in a
// new version. Unpublished counts, since publishing it again brings back what it had.
const contentEditableVersionStatuses: ModelStatus[] = [ModelStatus.Draft, ModelStatus.Training];

/**
 * Decision (2026-10-18): a dataset is fixed once training has started, so the run's results and its
 * review describe the bytes on record. Before the first run, and after a run that failed or expired
 * (a retry), a new dataset may be uploaded. A denied dataset is never replaced.
 */
const datasetEditableTrainingStatuses: (TrainingStatus | null)[] = [
  null,
  TrainingStatus.Pending,
  TrainingStatus.Failed,
  TrainingStatus.Expired,
];

/**
 * Whether a version may take new file content (a new upload behind one of its files, or a training
 * checkpoint copied into its storage). Throws the user-facing refusal when it may not.
 */
export function assertVersionAcceptsNewUpload(
  version: { status: ModelStatus; trainingStatus: TrainingStatus | null },
  fileType: string
) {
  if (!contentEditableVersionStatuses.includes(version.status))
    throw throwBadRequestError(
      'This version has been published. Upload the new file as a new version.'
    );
  if (
    fileType === 'Training Data' &&
    !datasetEditableTrainingStatuses.includes(version.trainingStatus)
  )
    throw throwBadRequestError(
      "Training data can't be changed after training has started. Create a new version to train again."
    );
}
