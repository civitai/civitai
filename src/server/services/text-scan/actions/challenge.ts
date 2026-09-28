import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { applyChallengeNsfwEscalation } from '~/server/games/daily-challenge/challenge-nsfw-escalation';
import { logToAxiom } from '~/server/logging/client';
import { recordChallengeScanResult } from '~/server/prom/challenge.metrics';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import type { ScanEntityResult } from '~/server/services/text-scan/submit';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

type SkipReason = Extract<ScanEntityResult, { status: 'skipped' }>['reason'];

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
export async function settleSkippedChallengeScan(entityId: number, reason: SkipReason) {
  if (reason === 'missing' || reason === 'in-flight') return;
  if (reason === 'too-short')
    return applyChallengeTextVerdict(entityId, NsfwLevel.PG, { countScan: true });
  if (reason === 'unchanged') {
    const live = await dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: 'Challenge', entityId } },
      select: { status: true, nsfwLevel: true, result: true },
    });
    const version = (live?.result as { version?: unknown } | null)?.version;
    if (live?.status === EntityModerationStatus.Succeeded && version != null)
      return applyChallengeTextVerdict(entityId, live.nsfwLevel ?? NsfwLevel.PG, {
        countScan: false,
      });
  }
  logToAxiom({
    name: 'text-scan',
    type: 'error',
    message: 'challenge scan skipped; ingestion left Pending',
    challengeId: entityId,
    reason,
  }).catch(() => null);
}
