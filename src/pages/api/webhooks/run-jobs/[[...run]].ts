import * as z from 'zod';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { addOnDemandRunStrategiesJob } from '~/server/jobs/add-on-demand-run-strategies';
import { auditRemixSourcesJob } from '~/server/jobs/audit-remix-sources';
import { dedupeOfficialUploadsJob } from '~/server/jobs/dedupe-official-uploads';
import { applyContestTags } from '~/server/jobs/apply-contest-tags';
import { applyDiscordRoles } from '~/server/jobs/apply-discord-roles';
import { applyNsfwBaseline } from '~/server/jobs/apply-nsfw-baseline';
import { applyTagRules } from '~/server/jobs/apply-tag-rules';
import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { cacheCleanup } from '~/server/jobs/cache-cleanup';
import { checkProcessingResourceTrainingV2 } from '~/server/jobs/check-processing-resource-training-v2';
import { cleanImageResources } from '~/server/jobs/clean-image-resources';
import { clearVaultItems } from '~/server/jobs/clear-vault-items';
import { reconcileVaultStorage } from '~/server/jobs/reconcile-vault-storage';
import { contestCollectionVimeoUpload } from '~/server/jobs/collection-contest-vimeo-upload';
import { contestCollectionYoutubeUpload } from '~/server/jobs/collection-contest-youtube-upload';
import { collectionGameProcessing } from '~/server/jobs/collection-game-processing';
import { updateCollectionItemRandomId } from '~/server/jobs/collection-item-random-id';
import { checkImageExistence } from '~/server/jobs/confirm-image-existence';
import { confirmMutes } from '~/server/jobs/confirm-mutes';
import { confirmPendingBlockAttributions } from '~/server/jobs/confirm-pending-block-attributions';
import { bulkPayoutBlockAttributions } from '~/server/jobs/bulk-payout-block-attributions';
import { reapDevTunnelsJob } from '~/server/jobs/reap-dev-tunnels';
import { custodySweepJob } from '~/server/jobs/custody-sweep';
import { reconcileNowpaymentsJob } from '~/server/jobs/reconcile-nowpayments';
import { notifyStuckCryptoDepositsJob } from '~/server/jobs/notify-stuck-crypto-deposits';
import { countReviewImages } from '~/server/jobs/count-review-images';
import { creatorProgramJobs } from '~/server/jobs/creators-program-jobs';
import { challengeActivationJob } from '~/server/jobs/challenge-activation';
import { challengeAutoQueueJob } from '~/server/jobs/challenge-auto-queue';
import { challengeCompletionJob } from '~/server/jobs/challenge-completion';
import { dailyChallengeJobs } from '~/server/jobs/daily-challenge-processing';
import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';
import { deliverAnnualSubscriptionBuzz } from '~/server/jobs/deliver-annual-sub-buzz';
import { purgeReplacedFilesJob } from '~/server/jobs/purge-replaced-files';
import {
  advanceReferralSubs,
  expireReferralTokens,
  settleReferralRewards,
} from '~/server/jobs/referral-program-jobs';
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
import { syncEmailBlocklist } from '~/server/jobs/sync-email-blocklist';
import { bountyJobs } from '~/server/jobs/prepare-bounties';
import { leaderboardJobs } from '~/server/jobs/prepare-leaderboard';
// import { processCreatorProgramImageGenerationRewards } from '~/server/jobs/process-creator-program-image-generation-rewards';
import { csamJobs } from '~/server/jobs/process-csam';
import { processingEngingEarlyAccess } from '~/server/jobs/process-ending-early-access';
import { processImportsJob } from '~/server/jobs/process-imports';
import { processRewards, rewardsDailyReset } from '~/server/jobs/process-rewards';
import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';
import { processSubscriptionsRequiringRenewal } from '~/server/jobs/process-subscriptions-requiring-renewal';
import { processVaultItems } from '~/server/jobs/process-vault-items';
import { auditWildcardSetCategoriesJob } from '~/server/jobs/audit-wildcard-set-categories';
import { reconcileWildcardSetsJob } from '~/server/jobs/reconcile-wildcard-sets';
import { pushDiscordMetadata } from '~/server/jobs/push-discord-metadata';
import { refreshAuctionCache } from '~/server/jobs/refresh-auction-cache';
import { refreshFeaturedCollectionsEligibility } from '~/server/jobs/refresh-featured-collections-eligibility';
import { reemitBitdexOps } from '~/server/jobs/reemit-bitdex-ops';
import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { reindexRecentScheduledImages } from '~/server/jobs/reindex-recent-scheduled-images';
import { resetToDraftWithoutRequirements } from '~/server/jobs/reset-to-draft-without-requirements';
import { resourceGenerationAvailability } from '~/server/jobs/resource-generation-availability';
import { retroactiveHashBlocking } from '~/server/jobs/retroactive-hash-blocking';
import { rewardsAbusePrevention } from '~/server/jobs/rewards-abuse-prevention';
import { rewardsAdImpressions } from '~/server/jobs/rewards-ad-impressions';
import { scanFilesFallbackJob } from '~/server/jobs/scan-files';
import { searchIndexCleanupJob } from '~/server/jobs/search-index-cleanup';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { searchIndexUserCleanupJob } from '~/server/jobs/search-index-user-cleanup';
import { sendCollectionNotifications } from '~/server/jobs/send-collection-notifications';
import { sendNotificationsJob } from '~/server/jobs/send-notifications';
import { notificationCursorMonitor } from '~/server/jobs/notification-cursor-monitor';
import { sendWebhooksJob } from '~/server/jobs/send-webhooks';
import { tempSetMissingNsfwLevel } from '~/server/jobs/temp-set-missing-nsfw-level';
import { retryFailedTextModeration } from '~/server/jobs/text-moderation-retry';
import { articleIngestionReconcile } from '~/server/jobs/article-ingestion-reconcile';
import { metricJobs } from '~/server/jobs/update-metrics';
import { updateModelVersionNsfwLevelsJob } from '~/server/jobs/update-model-version-nsfw-levels';
import { updateUserScore } from '~/server/jobs/update-user-score';
import { userDeletedCleanup } from '~/server/jobs/user-deleted-cleanup';
import { expireStrikesJob, processTimedUnmutesJob } from '~/server/jobs/process-strikes';
import { processEnqueuedComicPanelsJob } from '~/server/jobs/process-enqueued-comic-panels';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';

export const jobs: Job[] = [
  scanFilesFallbackJob,
  processImportsJob,
  sendNotificationsJob,
  notificationCursorMonitor,
  sendWebhooksJob,
  addOnDemandRunStrategiesJob,
  deliverPurchasedCosmetics,
  deliverLeaderboardCosmetics,
  reindexRecentScheduledImages,
  reemitBitdexOps,
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
  purgeReplacedFilesJob,
  updateCollectionItemRandomId,
  refreshFeaturedCollectionsEligibility,
  ...metricJobs,
  ...searchIndexJobs,
  searchIndexUserCleanupJob,
  searchIndexCleanupJob,
  processRewards,
  rewardsDailyReset,
  ...bountyJobs,
  eventEngineDailyReset,
  eventEngineLeaderboardUpdate,
  ...csamJobs,
  resourceGenerationAvailability,
  cacheCleanup,
  rewardsAbusePrevention,
  nextauthCleanup,
  syncEmailBlocklist,
  applyTagRules,
  // processCreatorProgramImageGenerationRewards,
  processVaultItems,
  reconcileVaultStorage,
  clearVaultItems,
  reconcileWildcardSetsJob,
  auditWildcardSetCategoriesJob,
  ...jobQueueJobs,
  countReviewImages,
  processingEngingEarlyAccess,
  updateUserScore,
  tempSetMissingNsfwLevel,
  imagesCreatedEvents,
  updateCreatorResourceCompensation,
  confirmMutes,
  confirmPendingBlockAttributions,
  bulkPayoutBlockAttributions,
  reapDevTunnelsJob,
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
  settleReferralRewards,
  expireReferralTokens,
  advanceReferralSubs,
  ...prepaidMembershipJobs,
  ...entityModerationJobs,
  retryFailedTextModeration,
  articleIngestionReconcile,
  expireStrikesJob,
  processTimedUnmutesJob,
  custodySweepJob,
  reconcileNowpaymentsJob,
  notifyStuckCryptoDepositsJob,
  processEnqueuedComicPanelsJob,
  auditRemixSourcesJob,
  dedupeOfficialUploadsJob,
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

  const lock = await acquireLock(name, options.lockExpiration, noCheck);
  if (!lock)
    return res.status(200).json({ ok: true, error: 'Job already running' });

  const jobStart = Date.now();
  const axiom = req.log.with({ scope: 'job', name, pod });
  let result: MixedObject | void;
  try {
    log(`${name} starting`);
    axiom.info(`starting`);

    const jobRunner = run({ req });

    const cancelHandler = async () => {
      await jobRunner.cancel();
      await lock.release();
    };

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
    await lock.release();
  }
});

const LOCK_REFRESH_INTERVAL = 8; // Every 8 seconds
const LOCK_BUFFER = 2; // 2 second buffer on redis expiry

// Release only if we still hold the token. The old blind DEL let a fast run
// free a concurrent slow run's lock.
const LOCK_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
// Extend the TTL only if we still hold the token (don't clobber a lock that
// expired and was re-acquired by another run).
const LOCK_REFRESH_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
  else
    return 0
  end
`;

// A held job lock. `release()` is idempotent and closes over THIS run's token +
// interval only — it can never free or clear a different (newer) run's lock,
// which is why token/interval must be per-invocation, not keyed by job name.
type JobLock = { release: () => Promise<void> };
const NOOP_LOCK: JobLock = { release: async () => undefined };

// Atomically acquire the job lock. Returns null if another run already holds it.
// Uses SET NX (atomic check-and-set) instead of the old GET-then-SET, which let
// two concurrent triggers both pass the check and run the same job in parallel
// (e.g. the duplicate ingest-images cron triggers).
async function acquireLock(
  name: string,
  lockExpiration: number,
  noCheck?: boolean
): Promise<JobLock | null> {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return NOOP_LOCK;
  // Redis unavailable — fail open (run without a lock), matching prior behavior.
  if (!sysRedis) return NOOP_LOCK;

  const token = `${pod ?? 'unknown'}:${Date.now()}-${Math.random()}`;
  let acquired: string | null;
  try {
    acquired = await sysRedis.set(`${REDIS_SYS_KEYS.JOB}:${name}`, token, {
      NX: true,
      EX: LOCK_REFRESH_INTERVAL + LOCK_BUFFER,
    });
  } catch (e) {
    // Redis errored on acquire — fail open (run unlocked) rather than skip.
    logToAxiom(
      { type: 'job-lock', message: 'acquire-error', job: name, error: (e as Error)?.message },
      'webhooks'
    ).catch();
    return NOOP_LOCK;
  }
  if (acquired !== 'OK') return null;

  logToAxiom({ type: 'job-lock', message: 'lock', job: name }, 'webhooks').catch();

  let released = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const release = async () => {
    if (released) return;
    released = true;
    if (interval) clearInterval(interval);
    logToAxiom({ type: 'job-lock', message: 'unlock', job: name }, 'webhooks').catch();
    await sysRedis
      ?.eval(LOCK_RELEASE_SCRIPT, {
        keys: [`${REDIS_SYS_KEYS.JOB}:${name}`],
        arguments: [token],
      })
      .catch(() => undefined);
  };

  // Refresh while we still own the lock so long jobs keep it and dead pods
  // release it (the short TTL lapses). Hard-cap total hold at lockExpiration.
  let ttl = lockExpiration;
  interval = setInterval(async () => {
    ttl -= LOCK_REFRESH_INTERVAL;
    if (ttl <= 0) {
      release().catch(() => undefined);
      return;
    }
    await sysRedis
      ?.eval(LOCK_REFRESH_SCRIPT, {
        keys: [`${REDIS_SYS_KEYS.JOB}:${name}`],
        arguments: [token, String(LOCK_REFRESH_INTERVAL + LOCK_BUFFER)],
      })
      .catch(() => undefined);
  }, LOCK_REFRESH_INTERVAL * 1000);

  return { release };
}
