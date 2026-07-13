import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getChallengesReadyToStart,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { getUnscannedUserChallengesPastStart } from '~/server/games/daily-challenge/challenge-helpers';
import { scanUserChallenge, voidChallenge } from '~/server/services/challenge.service';
import { ChallengeIngestionStatus } from '~/shared/utils/prisma/enums';
import { startScheduledChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';

const log = createLogger('jobs:challenge-activation', 'blue');

// Pending/Error scans get re-scan attempts for this long past startsAt before the challenge is
// voided — bounds "stuck Scheduled+hidden with escrowed funds forever" when the scan service
// stays down, while giving transient failures time to recover.
const UNSCANNED_VOID_GRACE_MS = 24 * 60 * 60 * 1000;

export const challengeActivationJob = createJob('challenge-activation', '0 * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

  // User challenges past start that never passed scan can't activate (getChallengesReadyToStart
  // requires Scanned). Blocked → void now (refunds fees + prize). Pending/Error → re-submit the
  // scan; it resolves asynchronously via the moderation webhook, so a later run activates it once
  // it reaches Scanned. Still unscanned after the grace window → void so the escrow isn't stranded.
  const unscanned = await getUnscannedUserChallengesPastStart();
  for (const { id: challengeId, ingestion, startsAt } of unscanned) {
    try {
      if (ingestion !== ChallengeIngestionStatus.Blocked) {
        await scanUserChallenge(challengeId);
        const gracePassed = Date.now() - startsAt.getTime() > UNSCANNED_VOID_GRACE_MS;
        const { ingestion: rescanned } =
          (await dbWrite.challenge.findUnique({
            where: { id: challengeId },
            select: { ingestion: true },
          })) ?? {};
        if (rescanned === ChallengeIngestionStatus.Scanned) {
          log(`Re-scan recovered user challenge ${challengeId}`);
          continue;
        }
        if (rescanned !== ChallengeIngestionStatus.Blocked && !gracePassed) continue;
      }
      await voidChallenge(challengeId);
      log(`Voided unscanned user challenge ${challengeId} (${ingestion})`);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'challenge-activation-void-blocked',
        message: err.message,
        challengeId,
      });
      log(`Failed to void unscanned challenge ${challengeId}:`, error);
    }
  }

  const challengesToStart = await getChallengesReadyToStart();
  if (!challengesToStart.length) return;

  const config = await getChallengeConfig();
  log(`Activating ${challengesToStart.length} challenge(s)`);

  for (const challenge of challengesToStart) {
    try {
      await startScheduledChallenge(challenge, config);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'challenge-activation',
        message: err.message,
        challengeId: challenge.challengeId,
      });
      log(`Failed to activate challenge ${challenge.challengeId}:`, error);
    }
  }
});
