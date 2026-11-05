import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ScanResultCode } from '~/shared/utils/prisma/enums';

// `Error` (the scanner broke) and `Pending` are deliberately not failures: only a finding is.
// The GenerationCoverage view states the same rule in SQL.
export function hasFailedScan(file: {
  pickleScanResult?: ScanResultCode | null;
  virusScanResult?: ScanResultCode | null;
}) {
  return (
    file.pickleScanResult === ScanResultCode.Danger ||
    file.virusScanResult === ScanResultCode.Danger
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
