import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
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
 * GenerationCoverage's file test, stricter than hasFailedScan: a scanner Error also uncovers the
 * version. The migration that defines the view states the same rule in SQL.
 */
export function excludedFromCoverage(file: {
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
}) {
  return (
    hasFailedScan(file) ||
    file.pickleScanResult === ScanResultCode.Error ||
    file.virusScanResult === ScanResultCode.Error
  );
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
