import { Prisma } from '@prisma/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { isDatasetEditable } from '~/shared/constants/training.constants';
import type { TrainingStatus } from '~/shared/utils/prisma/enums';
import { ModelStatus, ModelUploadType, ScanResultCode } from '~/shared/utils/prisma/enums';
import { LOADABLE_FILE_TYPES } from '~/server/services/resource-residency.service';
import { getModelFileFormat, unscannedFile } from '~/utils/file-helpers';
import { getFileExtension } from '~/utils/string-helpers';

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

type ScanResetFile = {
  type: string;
  name: string;
  metadata: unknown;
  pickleScanResult: ScanResultCode;
  virusScanResult: ScanResultCode;
};
type FileChange = { type?: string; name?: string; format?: string | null };

const nameFormat = (name: string) => getModelFileFormat(name.toLowerCase());
const formatOf = (file: { name: string; metadata: unknown }) =>
  (file.metadata as { format?: string } | null)?.format ?? nameFormat(file.name);
const extension = (name: string) => getFileExtension(name.toLowerCase());
const NOT_CLEAN: ScanResultCode[] = [ScanResultCode.Danger, ScanResultCode.Error];

/** A new format the file's name does not have. A zip's contents can't be told from its name. */
export function formatMismatch(file: { name: string; metadata: unknown }, change: FileChange) {
  if (change.format == null || change.format === formatOf(file)) return false;
  const name = change.name ?? file.name;
  return extension(name) !== 'zip' && change.format !== nameFormat(name);
}

/** Refuses an owner a format the file name does not have. */
export function assertFormatChangeAllowed(
  file: { name: string; metadata: unknown },
  change: FileChange,
  isModerator: boolean
) {
  if (!isModerator && formatMismatch(file, change))
    throw throwBadRequestError(
      "A file's format must match its file name. Upload the file again to change its format."
    );
}

/**
 * Training Data goes back to unscanned when it is relabelled, since it has only had a virus scan.
 * Any other file does when it becomes a type a loader opens, or its name's extension or its format
 * changes. A verdict that is not clean stands.
 */
function resetsScan(file: ScanResetFile, change: FileChange) {
  const nextType = change.type && change.type !== file.type ? change.type : undefined;
  if (file.type === 'Training Data') return !!nextType;
  if (NOT_CLEAN.includes(file.pickleScanResult) || NOT_CLEAN.includes(file.virusScanResult))
    return false;
  const becameLoadable =
    !!nextType &&
    LOADABLE_FILE_TYPES.includes(nextType) &&
    !LOADABLE_FILE_TYPES.includes(file.type);
  const renamed = !!change.name && extension(change.name) !== extension(file.name);
  const nextFormat =
    change.format === undefined ? undefined : change.format ?? nameFormat(change.name ?? file.name);
  const changedFormat = nextFormat !== undefined && nextFormat !== formatOf(file);
  return becameLoadable || renamed || changedFormat;
}

/** The scan fields to write with a file change. */
export function scanResetForFileChange(file: ScanResetFile, change: FileChange) {
  // A Json column takes Prisma.JsonNull, never a bare null.
  return resetsScan(file, change) ? { ...unscannedFile, rawScanResult: Prisma.JsonNull } : {};
}

/**
 * The condition a write that resets a scan (a relabel, a rename, a format change, a file becoming
 * loadable) must add: it may only replace the verdicts it was judged on, never one that landed since.
 */
export function scanResetWriteGuard(file: ScanResetFile, change: FileChange) {
  if (!resetsScan(file, change)) return {};
  return file.type === 'Training Data'
    ? { virusScanResult: ScanResultCode.Success }
    : { virusScanResult: file.virusScanResult, pickleScanResult: file.pickleScanResult };
}

/** Why a file change guarded by scanResetWriteGuard wrote nothing. */
export function scanResetConflictMessage(file: { type: string }) {
  return file.type === 'Training Data'
    ? TRAINING_DATA_SCAN_PENDING_MESSAGE
    : 'This file was scanned while you were editing it. Try again.';
}
