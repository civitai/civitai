import { z } from 'zod';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { addOnDemandRunStrategiesJob } from '~/server/jobs/add-on-demand-run-strategies';
import { applyContestTags } from '~/server/jobs/apply-contest-tags';
import { applyDiscordRoles } from '~/server/jobs/apply-discord-roles';
import { applyNsfwBaseline } from '~/server/jobs/apply-nsfw-baseline';
import { applyTagRules } from '~/server/jobs/apply-tag-rules';
import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { cacheCleanup } from '~/server/jobs/cache-cleanup';
import { cleanImageResources } from '~/server/jobs/clean-image-resources';
import { clearVaultItems } from '~/server/jobs/clear-vault-items';
import { collectionGameProcessing } from '~/server/jobs/collection-game-processing';
import { updateCollectionItemRandomId } from '~/server/jobs/collection-item-random-id';
import { checkImageExistence } from '~/server/jobs/confirm-image-existence';
import { confirmMutes } from '~/server/jobs/confirm-mutes';
import { countReviewImages } from '~/server/jobs/count-review-images';
import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';
import { updateCreatorResourceCompensation } from '~/server/jobs/deliver-creator-compensation';
import { deliverLeaderboardCosmetics } from '~/server/jobs/deliver-leaderboard-cosmetics';
import { deliverPurchasedCosmetics } from '~/server/jobs/deliver-purchased-cosmetics';
import * as eventEngineJobs from '~/server/jobs/event-engine-work';
import { fullImageExistence } from '~/server/jobs/full-image-existence';
import { handleLongTrainings } from '~/server/jobs/handle-long-trainings';
// import { refreshImageGenerationCoverage } from '~/server/jobs/refresh-image-generation-coverage';
import { ingestImages, removeBlockedImages } from '~/server/jobs/image-ingestion';
import { imagesCreatedEvents } from '~/server/jobs/images-created-events';
import { Job } from '~/server/jobs/job';
import { jobQueueJobs } from '~/server/jobs/job-queue';
import { nextauthCleanup } from '~/server/jobs/next-auth-cleanup';
import { bountyJobs } from '~/server/jobs/prepare-bounties';
import { leaderboardJobs } from '~/server/jobs/prepare-leaderboard';
import { processClubMembershipRecurringPayments } from '~/server/jobs/process-club-membership-recurring-payments';
import { processCreatorProgramEarlyAccessRewards } from '~/server/jobs/process-creator-program-early-access-rewards';
import { processCreatorProgramImageGenerationRewards } from '~/server/jobs/process-creator-program-image-generation-rewards';
import { csamJobs } from '~/server/jobs/process-csam';
import { processingEngingEarlyAccess } from '~/server/jobs/process-ending-early-access';
import { processImportsJob } from '~/server/jobs/process-imports';
import { processRewards, rewardsDailyReset } from '~/server/jobs/process-rewards';
import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';
import { processSubscriptionsRequiringRenewal } from '~/server/jobs/process-subscriptions-requiring-renewal';
import { processVaultItems } from '~/server/jobs/process-vault-items';
import { pushDiscordMetadata } from '~/server/jobs/push-discord-metadata';
import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { resetImageViewCounts } from '~/server/jobs/reset-image-view-counts';
import { resetToDraftWithoutRequirements } from '~/server/jobs/reset-to-draft-without-requirements';
import { resourceGenerationAvailability } from '~/server/jobs/resource-generation-availability';
import { rewardsAbusePrevention } from '~/server/jobs/rewards-abuse-prevention';
import { rewardsAdImpressions } from '~/server/jobs/rewards-ad-impressions';
import { scanFilesJob } from '~/server/jobs/scan-files';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { sendCollectionNotifications } from '~/server/jobs/send-collection-notifications';
import { sendNotificationsJob } from '~/server/jobs/send-notifications';
import { sendWebhooksJob } from '~/server/jobs/send-webhooks';
import { tempSetMissingNsfwLevel } from '~/server/jobs/temp-set-missing-nsfw-level';
import { metricJobs } from '~/server/jobs/update-metrics';
import { updateUserScore } from '~/server/jobs/update-user-score';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
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
  ...leaderboardJobs,
  ingestImages,
  removeBlockedImages,
  processScheduledPublishing,
  // refreshImageGenerationCoverage,
  cleanImageResources,
  deleteOldTrainingData,
  handleLongTrainings,
  updateCollectionItemRandomId,
  ...metricJobs,
  ...searchIndexJobs,
  processRewards,
  rewardsDailyReset,
  ...bountyJobs,
  ...Object.values(eventEngineJobs),
  processClubMembershipRecurringPayments,
  ...csamJobs,
  resourceGenerationAvailability,
  cacheCleanup,
  rewardsAbusePrevention,
  nextauthCleanup,
  applyTagRules,
  processCreatorProgramEarlyAccessRewards,
  processCreatorProgramImageGenerationRewards,
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

    const jobRunner = run();

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
    if (name === 'update-nsfw-levels') {
      // TODO: Temporary, looking to get logs from the error.
      logToAxiom({ type: 'job-error', job: name, error }, 'webhooks');
    }
    res.status(500).json({ ok: false, pod, error });
  } finally {
    await unlock(name, noCheck);
  }
});

async function isLocked(name: string, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return false;
  return (await redis?.get(`job:${name}`)) === 'true';
}

async function lock(name: string, lockExpiration: number, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return;
  logToAxiom({ type: 'job-lock', message: 'lock', job: name }, 'webhooks');
  await redis?.set(`job:${name}`, 'true', { EX: lockExpiration });
}

async function unlock(name: string, noCheck?: boolean) {
  if (!isProd || name === 'prepare-leaderboard' || noCheck) return;
  logToAxiom({ type: 'job-lock', message: 'unlock', job: name }, 'webhooks');
  await redis?.del(`job:${name}`);
}
