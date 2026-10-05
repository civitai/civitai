import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { applyCrucibleNsfwEscalation } from '~/server/services/crucible-nsfw-escalation';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import type { ScanEntityResult } from '~/server/services/text-scan/submit';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

type SkipReason = Extract<ScanEntityResult, { status: 'skipped' }>['reason'];

// The detected level, not `raised`: after one escalation the declared level is R, so a rescan of
// the same text never reads as raised.
const escalate = (entityId: number, level: number) =>
  applyCrucibleNsfwEscalation({ entityId, isNsfw: level >= NsfwLevel.R, greenCancels: false });

export async function applyCrucibleTextScan({ entityId, outcome }: ApplyTextScanArgs) {
  if (!outcome.nsfw) return;
  await escalate(entityId, outcome.nsfw.detectedLevel);
}

// A new or edited crucible is hidden until Scanned, so every skip must settle it or say why not.
export async function settleSkippedCrucibleScan(entityId: number, reason: SkipReason) {
  if (reason === 'missing' || reason === 'in-flight') return;
  if (reason === 'too-short') return escalate(entityId, NsfwLevel.PG);
  if (reason === 'unchanged') {
    const live = await dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: 'Crucible', entityId } },
      select: { status: true, nsfwLevel: true, result: true },
    });
    const version = (live?.result as { version?: unknown } | null)?.version;
    if (live?.status === EntityModerationStatus.Succeeded && version != null)
      return escalate(entityId, live.nsfwLevel ?? NsfwLevel.PG);
  }
  logToAxiom({
    name: 'text-scan',
    type: 'error',
    message: 'crucible scan skipped; ingestion left Pending',
    crucibleId: entityId,
    reason,
  }).catch(() => null);
}
