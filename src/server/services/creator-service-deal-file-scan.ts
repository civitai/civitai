import { ensureFliptInitialized, getFliptClientSync } from '~/server/flipt/client';
import { getFeatureFliptKey } from '~/server/services/feature-flags.service';

/**
 * The seam between a delivered Final and whatever scans it.
 *
 * A Final's `scanStatus` starts Pending and only a scanner's verdict moves it, through
 * `recordFinalScanResult` in the file service. Nothing here can produce Passed: `submitFinalScan`
 * is typed to return Pending and today does nothing else, so with the malware scan on and no scanner
 * wired no Final is ever downloadable. Paying out on a deal whose Finals are unscanned is stopped by
 * the completion gate in the deal service, not here. The real scanner replaces this function's body
 * and reports its verdict from its result handler.
 */
export type FinalScanTarget = {
  id: number;
  dealId: number;
  s3Key: string;
  mimeType: string;
  size: number;
};

export async function submitFinalScan(file: FinalScanTarget): Promise<'Pending'> {
  void file;
  return 'Pending';
}

/**
 * Whether Finals go to the malware scan. Off means the step is skipped: the Final's
 * `malwareScanStatus` is recorded as NotScanned, never Passed, and every image inside it is still
 * scanned and still decides the verdict.
 *
 * Skipped only on an answer from Flipt: the flag set off, or not created yet. When Flipt cannot be
 * reached the scan stays on, so an outage never lets a Final through unscanned. `isFlipt` turns both
 * cases into false, so this asks the client directly. Read through one synthetic entity, so launch it
 * by setting the flag's `enabled`, not by percentage.
 */
export async function isFinalsMalwareScanOn() {
  const flagKey = getFeatureFliptKey('creatorServicesFinalsMalwareScan');
  if (!flagKey) return true;
  try {
    await ensureFliptInitialized();
  } catch {
    return true;
  }
  const client = getFliptClientSync();
  if (!client) return true;
  try {
    return client.evaluateBoolean({
      flagKey,
      entityId: '0',
      context: { userId: '0', isModerator: 'false' },
    }).enabled;
  } catch {
    // The client has a config and the flag is not in it.
    return false;
  }
}
