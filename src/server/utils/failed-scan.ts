import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { LOADABLE_FILE_TYPES } from '~/server/services/resource-residency.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ScanResultCode } from '~/shared/utils/prisma/enums';

// `Error` (the scanner broke) and `Pending` are deliberately not failures for publish and download:
// only a finding is.
export function hasFailedScan(file: {
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
}) {
  return (
    file.pickleScanResult === ScanResultCode.Danger ||
    file.virusScanResult === ScanResultCode.Danger
  );
}

/**
 * GenerationCoverage's file test, stricter than hasFailedScan: a scanner Error on a file the generator
 * loads also uncovers the version. The migration that defines the view states the same rule in SQL.
 */
export function excludedFromCoverage(file: {
  type: string;
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
}) {
  return (
    hasFailedScan(file) ||
    (LOADABLE_FILE_TYPES.includes(file.type) &&
      (file.pickleScanResult === ScanResultCode.Error ||
        file.virusScanResult === ScanResultCode.Error))
  );
}

/**
 * A vault entry's verdict stamped when its row was deleted, with both scans finished. The copy taken
 * when the file was vaulted can refuse the file but never clear it: the row may have changed since.
 */
export function hasSettledScanSnapshot(entry: {
  rowDeletedAt?: string | null;
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
}) {
  return (
    entry.rowDeletedAt != null &&
    entry.pickleScanResult != null &&
    entry.virusScanResult != null &&
    entry.pickleScanResult !== ScanResultCode.Pending &&
    entry.virusScanResult !== ScanResultCode.Pending
  );
}

/**
 * A vault file with no row by id or url and no settled snapshot of its verdict: whether a
 * non-moderator is refused it. The one place that policy is set.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the policy may come to read the entry
export function refuseUnjudgedVaultFile(entry: { id: number; url: string }) {
  return true;
}

export const failedScanFileWhere: Prisma.ModelFileWhereInput = {
  OR: [{ pickleScanResult: ScanResultCode.Danger }, { virusScanResult: ScanResultCode.Danger }],
};

export const FAILED_SCAN_DOWNLOAD_MESSAGE =
  'This file did not pass a security scan and is not available for download';

export const failedScanPublishMessage =
  'A file in this version did not pass the security scan. Remove or replace it before publishing.';

/** Refuses the publish when any file of the versions `versions` selects failed its scan. */
export async function assertNoFailedScanFiles(versions: Prisma.ModelVersionWhereInput) {
  const failed = await dbWrite.modelFile.count({
    where: { modelVersion: versions, ...failedScanFileWhere },
  });
  if (failed) throw throwBadRequestError(failedScanPublishMessage);
}
