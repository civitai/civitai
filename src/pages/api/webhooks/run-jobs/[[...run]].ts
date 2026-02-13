import * as z from 'zod';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { addOnDemandRunStrategiesJob } from '~/server/jobs/add-on-demand-run-strategies';
import { applyContestTags } from '~/server/jobs/apply-contest-tags';
import { applyDiscordRoles } from '~/server/jobs/apply-discord-roles';
import { applyNsfwBaseline } from '~/server/jobs/apply-nsfw-baseline';
import { applyTagRules } from '~/server/jobs/apply-tag-rules';
import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { cacheCleanup } from '~/server/jobs/cache-cleanup';
import { checkProcessingResourceTrainingV2 } from '~/server/jobs/check-processing-resource-training-v2';
import { cleanImageResources } from '~/server/jobs/clean-image-resources';
import { clearVaultItems } from '~/server/jobs/clear-vault-items';
import { contestCollectionVimeoUpload } from '~/server/jobs/collection-contest-vimeo-upload';
import { contestCollectionYoutubeUpload } from '~/server/jobs/collection-contest-youtube-upload';
import { collectionGameProcessing } from '~/server/jobs/collection-game-processing';
import { updateCollectionItemRandomId } from '~/server/jobs/collection-item-random-id';
import { checkImageExistence } from '~/server/jobs/confirm-image-existence';
import { confirmMutes } from '~/server/jobs/confirm-mutes';
import { countReviewImages } from '~/server/jobs/count-review-images';
import { creatorProgramJobs } from '~/server/jobs/creators-program-jobs';
import { challengeActivationJob } from '~/server/jobs/challenge-activation';
import { challengeAutoQueueJob } from '~/server/jobs/challenge-auto-queue';
import { challengeCompletionJob } from '~/server/jobs/challenge-completion';
import { dailyChallengeJobs } from '~/server/jobs/daily-challenge-processing';
import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';
import { deliverAnnualSubscriptionBuzz } from '~/server/jobs/deliver-annual-sub-buzz';
import { prepaidMembershipJobs } from '~/server/jobs/prepaid-membership-jobs';
import { updateCreatorResourceCompensation } from '~/server/jobs/deliver-creator-compensation';
import { deliverLeaderboardCosmetics } from '~/server/jobs/deliver-leaderboard-cosmetics';
import { deliverPurchasedCosmetics } from '~/server/jobs/deliver-purchased-cosmetics';
import { dummyJob } from '~/server/jobs/dummy-job';
import { entityModerationJobs } from '~/server/jobs/entity-moderation';
import {
  eventEngineDailyReset,
  eventEngineLeaderboardUpdate,
} from '~/server/jobs/event-engine-work';
import { fullImageExistence } from '~/server/jobs/full-image-existence';
import { handleAuctions } from '~/server/jobs/handle-auctions';
// import { refreshImageGenerationCoverage } from '~/server/jobs/refresh-image-generation-coverage';
import { ingestImages, removeBlockedImages } from '~/server/jobs/image-ingestion';
import { imagesCreatedEvents } from '~/server/jobs/images-created-events';
import type { Job } from '~/server/jobs/job';
import { jobQueueJobs } from '~/server/jobs/job-queue';
import { newOrderJobs } from '~/server/jobs/new-order-jobs';
import { nextauthCleanup } from '~/server/jobs/next-auth-cleanup';
import { bountyJobs } from '~/server/jobs/prepare-bounties';
import { leaderboardJobs } from '~/server/jobs/prepare-leaderboard';
// import { processClubMembershipRecurringPayments } from '~/server/jobs/process-club-membership-recurring-payments';
// import { processCreatorProgramImageGenerationRewards } from '~/server/jobs/process-creator-program-image-generation-rewards';
import { csamJobs } from '~/server/jobs/process-csam';
import { processingEngingEarlyAccess } from '~/server/jobs/process-ending-early-access';
import { processImportsJob } from '~/server/jobs/process-imports';
import { processRewards, rewardsDailyReset } from '~/server/jobs/process-rewards';
import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';
import { processSubscriptionsRequiringRenewal } from '~/server/jobs/process-subscriptions-requiring-renewal';
import { processVaultItems } from '~/server/jobs/process-vault-items';
import { pushDiscordMetadata } from '~/server/jobs/push-discord-metadata';
import { refreshAuctionCache } from '~/server/jobs/refresh-auction-cache';
import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { resetImageViewCounts } from '~/server/jobs/reset-image-view-counts';
import { resetToDraftWithoutRequirements } from '~/server/jobs/reset-to-draft-without-requirements';
import { resourceGenerationAvailability } from '~/server/jobs/resource-generation-availability';
import { retroactiveHashBlocking } from '~/server/jobs/retroactive-hash-blocking';
import { rewardsAbusePrevention } from '~/server/jobs/rewards-abuse-prevention';
import { rewardsAdImpressions } from '~/server/jobs/rewards-ad-impressions';
import { scanFilesJob } from '~/server/jobs/scan-files';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { sendCollectionNotifications } from '~/server/jobs/send-collection-notifications';
import { sendNotificationsJob } from '~/server/jobs/send-notifications';
import { sendWebhooksJob } from '~/server/jobs/send-webhooks';
import { tempSetMissingNsfwLevel } from '~/server/jobs/temp-set-missing-nsfw-level';
import { metricJobs } from '~/server/jobs/update-metrics';
import { updateModelVersionNsfwLevelsJob } from '~/server/jobs/update-model-version-nsfw-levels';
import { updateUserScore } from '~/server/jobs/update-user-score';
import { userDeletedCleanup } from '~/server/jobs/user-deleted-cleanup';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

export const jobs: Job[] = [
  scanFilesJob,
  processImportsJob,
  sendNotificationsJob,
  sendWebhooksJob,
  addOnDemandRunStrategiesJob,
  deliverPurchasedCosmetics,
  deliverLeaderboardCosmetics,
  resetImageViewCounts,
  pushDiscordMetadata,
  applyVotedTags,
  removeOldDrafts,
  resetToDraftWithoutRequirements,
  applyContestTags,
  ...applyDiscordRoles,
  applyNsfwBaseline,
  userDeletedCleanup,
  ...leaderboardJobs,
  ingestImages,
  removeBlockedImages,
  processScheduledPublishing,
  // refreshImageGenerationCoverage,
  cleanImageResources,
  deleteOldTrainingData,
  updateCollectionItemRandomId,
  ...metricJobs,
  ...searchIndexJobs,
  processRewards,
  rewardsDailyReset,
  ...bountyJobs,
  eventEngineDailyReset,
  eventEngineLeaderboardUpdate,
  // processClubMembershipRecurringPayments,
  ...csamJobs,
  resourceGenerationAvailability,
  cacheCleanup,
  rewardsAbusePrevention,
  nextauthCleanup,
  applyTagRules,
  // processCreatorProgramImageGenerationRewards,
  processVaultItems,
  clearVaultItems,
  ...jobQueueJobs,
  countReviewImages,
  processingEngingEarlyAccess,
  updateUserScore,
  tempSetMissingNsfwLevel,
  imagesCreatedEvents,
  updateCreatorResourceCompensation,
  confirmMutes,
  checkImageExistence,
  fullImageExistence,
  rewardsAdImpressions,
  collectionGameProcessing,
  processSubscriptionsRequiringRenewal,
  sendCollectionNotifications,
  checkProcessingResourceTrainingV2,
  ...dailyChallengeJobs,
  challengeActivationJob,
  challengeCompletionJob,
  challengeAutoQueueJob,
  contestCollectionYoutubeUpload,
  contestCollectionVimeoUpload,
  dummyJob,
  retroactiveHashBlocking,
  ...creatorProgramJobs,
  handleAuctions,
  refreshAuctionCache,
  ...newOrderJobs,
  updateModelVersionNsfwLevelsJob,
  deliverAnnualSubscriptionBuzz,
  ...prepaidMembershipJobs,
  ...entityModerationJobs,
];

const log = createLogger('jobs', 'green');
const pod = env.PODNAME;

const querySchema = z.object({
  run: z
    .union([z.string(), z.string().array()])
    .transform((x) => (Array.isArray(x) ? x[0] : x))
    .optional(),
  noCheck: booleanString().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const { run: runJob, noCheck } = querySchema.parse(req.query);

  // Get requested job
  const job = jobs.find((x) => x.name === runJob);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  const { name, run, options } = job;

  if (await isLocked(name, noCheck))
    return res.status(200).json({ ok: true, error: 'Job already running' });

  const jobStart = Date.now();
  const axiom = req.log.with({ scope: 'job', name, pod });
  let result: MixedObject | void;
  try {
    log(`${name} starting`);
    axiom.info(`starting`);
    await lock(name, options.lockExpiration, noCheck);

    const jobRunner = run({ req });

    async function cancelHandler() {
      await jobRunner.cancel();
      await unlock(name, noCheck);
    }

    res.on('close', cancelHandler);
    result = await jobRunner.result;
    res.off('close', cancelHandler);
    log(`${name} successful: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`);
    axiom.info('success', { duration: Date.now() - jobStart });
    res.status(200).json({ ok: true, pod, result: result ?? null });
  } catch (error) {
    log(`${name} failed: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`, error);
    axiom.error(`failed`, { duration: Date.now() - jobStart, error });
    res.status(500).json({ ok: false, pod, error, stack: (error as Error)?.stack });
  } finally {
    await unlock(name, noCheck);
  }
});

async function isLocked(name: string, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return false;
  return (await sysRedis?.get(`${REDIS_SYS_KEYS.JOB}:${name}`)) === 'true';
}

const LOCK_REFRESH_INTERVAL = 8; // Every 8 seconds
const LOCK_BUFFER = 2; // 2 second buffer on redis expiry
const lockIntervals: Record<string, ReturnType<typeof setInterval>> = {};
async function lock(name: string, lockExpiration: number, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return;
  logToAxiom({ type: 'job-lock', message: 'lock', job: name }, 'webhooks').catch();

  // Use refreshing lock mechanism to handle dying job pods
  async function refreshLock() {
    await sysRedis?.set(`${REDIS_SYS_KEYS.JOB}:${name}`, 'true', {
      EX: LOCK_REFRESH_INTERVAL + LOCK_BUFFER,
    });
  }
  let ttl = lockExpiration;
  lockIntervals[name] = setInterval(async () => {
    await refreshLock();
    ttl -= LOCK_REFRESH_INTERVAL;
    if (ttl <= 0) unlock(name, noCheck).catch(); // Unlock if expired
  }, LOCK_REFRESH_INTERVAL * 1000);
  await refreshLock();
}

async function unlock(name: string, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return;
  logToAxiom({ type: 'job-lock', message: 'unlock', job: name }, 'webhooks').catch();
  if (lockIntervals[name]) clearInterval(lockIntervals[name]); // Clear lock refresh interval
  await sysRedis?.del(`${REDIS_SYS_KEYS.JOB}:${name}`);
}
