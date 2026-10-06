import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { applyChallengeNsfwEscalation } from '~/server/games/daily-challenge/challenge-nsfw-escalation';
import { recordChallengeScanResult } from '~/server/prom/challenge.metrics';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  settleSkippedScan,
  type SkipReason,
} from '~/server/services/text-scan/actions/settle-skipped';

async function applyChallengeTextVerdict(
  entityId: number,
  detectedLevel: number,
  { countScan }: { countScan: boolean }
) {
  const challenge = await dbWrite.challenge.findUnique({
    where: { id: entityId },
    select: { source: true },
  });
  if (!challenge) return;
  if (countScan) recordChallengeScanResult({ source: challenge.source, result: 'scanned' });
  // The detected level, not `raised`: after one escalation the declared level is R, so a
  // rescan of the same text never reads as raised.
  await applyChallengeNsfwEscalation({ entityId, isNsfw: detectedLevel >= NsfwLevel.R });
}

export async function applyChallengeTextScan({ entityId, outcome }: ApplyTextScanArgs) {
  if (!outcome.nsfw) return;
  await applyChallengeTextVerdict(entityId, outcome.nsfw.detectedLevel, { countScan: true });
}

// The edit path marks ingestion Pending by its own text comparison, which differs from the
// scan's composed text, so a skipped scan would otherwise leave the challenge hidden.
export const settleSkippedChallengeScan = (entityId: number, reason: SkipReason) =>
  settleSkippedScan(
    'Challenge',
    entityId,
    reason,
    (level, { stored }) => applyChallengeTextVerdict(entityId, level, { countScan: !stored }),
    { challengeId: entityId }
  );
