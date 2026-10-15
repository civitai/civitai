/**
 * The seam between a delivered Final and whatever scans it.
 *
 * A Final's `scanStatus` starts Pending and only a scanner's verdict moves it, through
 * `recordFinalScanResult` in the file service. Nothing here can produce Passed: `submitFinalScan`
 * is typed to return Pending and today does nothing else, so with no scanner wired nothing is ever
 * downloadable and no deal can complete on an unscanned file. The real scanner replaces this
 * function's body and reports its verdict from its result handler.
 */
export type FinalScanTarget = {
  id: number;
  dealId: number;
  s3Key: string;
  mimeType: string;
  size: number;
};

export async function submitFinalScan(_file: FinalScanTarget): Promise<'Pending'> {
  return 'Pending';
}
