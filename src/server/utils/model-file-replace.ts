import { throwBadRequestError } from '~/server/utils/errorHandling';
import { isDatasetEditable } from '~/shared/constants/training.constants';
import type { TrainingStatus } from '~/shared/utils/prisma/enums';
import { ModelStatus, ModelUploadType, ScanResultCode } from '~/shared/utils/prisma/enums';
import { unscannedFile } from '~/utils/file-helpers';

// A version that has been out in the world (or is about to be) keeps its files; new bytes go in a
// new version. Unpublished counts, since publishing it again brings back what it had.
const contentEditableVersionStatuses: ModelStatus[] = [ModelStatus.Draft, ModelStatus.Training];

type UploadTarget = { status: ModelStatus; trainingStatus: TrainingStatus | null };

/** Whether a new dataset upload to this version would be accepted (see assertVersionAcceptsNewUpload). */
export function versionAcceptsNewTrainingData(version: UploadTarget) {
  return (
    contentEditableVersionStatuses.includes(version.status) &&
    isDatasetEditable(version.trainingStatus)
  );
}

/**
 * Whether a version may take new file content (a new upload behind one of its files, or a training
 * checkpoint copied into its storage). Throws the user-facing refusal when it may not.
 */
export function assertVersionAcceptsNewUpload(version: UploadTarget, fileType: string) {
  if (!contentEditableVersionStatuses.includes(version.status))
    throw throwBadRequestError(
      'This version has been published. Upload the new file as a new version.'
    );
  if (fileType === 'Training Data' && !isDatasetEditable(version.trainingStatus))
    throw throwBadRequestError(
      "Training data can't be changed after training has started. Create a new version to train again."
    );
}

/**
 * Training data is stamped with its provenance when it is uploaded, and a training submit reads that
 * stamp, so on every version a file only becomes training data by being uploaded as it.
 *
 * On a trained version the dataset rules key on a file being training data, so there it never stops
 * being training data either. An uploaded model's training data is an ordinary attachment its owner
 * may relabel as something else. A training status counts as trained too: the owner can rewrite
 * `uploadType`, but cannot clear a status a moderator set (Paused, Denied), which is what the
 * dataset delete lock relies on.
 */
export function assertFileTypeChangeAllowed(
  file: {
    type: string;
    virusScanResult: ScanResultCode;
    modelVersion: { uploadType: ModelUploadType; trainingStatus: TrainingStatus | null };
  },
  nextType: string | undefined
) {
  if (!nextType || nextType === file.type) return;
  if (nextType === 'Training Data')
    throw throwBadRequestError(
      "A file can't be changed to training data. Upload the dataset as training data instead."
    );
  if (
    file.type === 'Training Data' &&
    (file.modelVersion.uploadType === ModelUploadType.Trained ||
      file.modelVersion.trainingStatus != null)
  )
    throw throwBadRequestError("A file can't be changed to or from training data.");
  if (file.type === 'Training Data' && file.virusScanResult !== ScanResultCode.Success)
    throw throwBadRequestError(TRAINING_DATA_SCAN_PENDING_MESSAGE);
}

export const TRAINING_DATA_SCAN_PENDING_MESSAGE =
  "Training data can't be changed to another type until its security scan completes.";

/**
 * The scan fields to write with a type change. Training Data has only had a virus scan, so a file
 * relabelled away from it goes back to unscanned, and the model-file scan picks it up as its new type.
 */
export function scanResetForTypeChange(file: { type: string }, nextType: string | undefined) {
  return resetsScan(file, nextType) ? unscannedFile : {};
}

/**
 * The condition a type change's write must add: the reset may only replace the Success it was
 * judged on, never a verdict that landed since.
 */
export function scanResetWriteGuard(file: { type: string }, nextType: string | undefined) {
  return resetsScan(file, nextType) ? { virusScanResult: ScanResultCode.Success } : {};
}

const resetsScan = (file: { type: string }, nextType: string | undefined) =>
  file.type === 'Training Data' && !!nextType && nextType !== file.type;
