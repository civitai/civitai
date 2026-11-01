import { getTextScanMode } from '~/server/services/text-scan/mode';
import {
  scanEntity,
  scanEntityInBackground,
  type ScanEntityResult,
} from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

type SubmittedWorkflow = { id?: string | null } | null | undefined;
type SkipReason = Extract<ScanEntityResult, { status: 'skipped' }>['reason'];

// Compared by identity. The retry cron deletes a gone entity's row, and keeps a not-public one's
// (a rating floor still reads its verdict) but stops retrying it.
export const TEXT_SCAN_ENTITY_GONE: SubmittedWorkflow = Object.freeze({ id: null });
export const TEXT_SCAN_ENTITY_NOT_PUBLIC: SubmittedWorkflow = Object.freeze({ id: null });

export function toSubmittedWorkflow(result: ScanEntityResult): SubmittedWorkflow {
  if (result.status === 'submitted') return { id: result.workflowId };
  if (result.status === 'skipped' && result.reason === 'missing') return TEXT_SCAN_ENTITY_GONE;
  if (result.status === 'skipped' && result.reason === 'not-public')
    return TEXT_SCAN_ENTITY_NOT_PUBLIC;
  return null;
}

export async function submitTextModerationOrScan({
  entityType,
  entityId,
  force,
  fromRetry,
  xguard,
  onActiveSkip,
}: {
  entityType: TextScanEntityType;
  entityId: number;
  force?: boolean;
  // The retry cron bumped the Pending row it resubmits; without this the in-flight dedupe skips it.
  fromRetry?: boolean;
  xguard: () => Promise<SubmittedWorkflow>;
  onActiveSkip?: (reason: SkipReason) => Promise<void>;
}): Promise<SubmittedWorkflow> {
  const mode = await getTextScanMode(entityType, entityId);
  if (mode === 'active') {
    const result = await scanEntity({ entityType, entityId, force, fromRetry });
    // The flag turned off between the two reads: XGuard owns the entity again.
    if (result.status === 'skipped' && result.reason === 'off') return xguard();
    if (result.status === 'skipped') await onActiveSkip?.(result.reason);
    return toSubmittedWorkflow(result);
  }
  const workflow = await xguard();
  if (mode === 'shadow') scanEntityInBackground({ entityType, entityId, force });
  return workflow;
}

// The filter locks nsfw, and a lock is something the scan can never lower — so both
// must not act on one entity. A create has no id yet; it takes id 0's bucket.
export async function legacyProfanityAutoNsfwApplies(
  entityType: 'Model' | 'Bounty',
  entityId: number | undefined
) {
  return (await getTextScanMode(entityType, entityId ?? 0)) !== 'active';
}
