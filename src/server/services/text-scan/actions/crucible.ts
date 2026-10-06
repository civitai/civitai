import { NsfwLevel } from '~/server/common/enums';
import { applyCrucibleNsfwEscalation } from '~/server/services/crucible-nsfw-escalation';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  settleSkippedScan,
  type SkipReason,
} from '~/server/services/text-scan/actions/settle-skipped';

// The detected level, not `raised`: after one escalation the declared level is R, so a rescan of
// the same text never reads as raised.
const escalate = (entityId: number, level: number) =>
  applyCrucibleNsfwEscalation({ entityId, isNsfw: level >= NsfwLevel.R, greenCancels: false });

export async function applyCrucibleTextScan({ entityId, outcome }: ApplyTextScanArgs) {
  if (!outcome.nsfw) return;
  await escalate(entityId, outcome.nsfw.detectedLevel);
}

// A new or edited crucible is hidden until Scanned.
export const settleSkippedCrucibleScan = (entityId: number, reason: SkipReason) =>
  settleSkippedScan('Crucible', entityId, reason, (level) => escalate(entityId, level), {
    crucibleId: entityId,
  });
