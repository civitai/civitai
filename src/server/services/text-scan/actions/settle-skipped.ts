import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ScanEntityResult } from '~/server/services/text-scan/submit';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

export type SkipReason = Extract<ScanEntityResult, { status: 'skipped' }>['reason'];

// `stored` marks a re-applied verdict from an earlier scan rather than a fresh outcome.
type ApplySkippedVerdict = (level: number, opts: { stored: boolean }) => Promise<unknown>;

// For entities hidden until Scanned: every skip must settle them or say why not.
export async function settleSkippedScan(
  entityType: 'Challenge' | 'Crucible',
  entityId: number,
  reason: SkipReason,
  apply: ApplySkippedVerdict,
  logContext: Record<string, unknown>
) {
  if (reason === 'missing' || reason === 'in-flight') return;
  if (reason === 'too-short') {
    await apply(NsfwLevel.PG, { stored: false });
    return;
  }
  if (reason === 'unchanged') {
    const live = await dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
      select: { status: true, nsfwLevel: true, result: true },
    });
    const version = (live?.result as { version?: unknown } | null)?.version;
    if (live?.status === EntityModerationStatus.Succeeded && version != null) {
      await apply(live.nsfwLevel ?? NsfwLevel.PG, { stored: true });
      return;
    }
  }
  logToAxiom({
    name: 'text-scan',
    type: 'error',
    message: `${entityType.toLowerCase()} scan skipped; ingestion left Pending`,
    ...logContext,
    reason,
  }).catch(() => null);
}
