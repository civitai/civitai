import { z } from 'zod';

import { addOnDemandRunStrategiesJob } from '~/server/jobs/add-on-demand-run-strategies';
import { deliverPurchasedCosmetics } from '~/server/jobs/deliver-purchased-cosmetics';
import { processImportsJob } from '~/server/jobs/process-imports';
import { scanFilesJob } from '~/server/jobs/scan-files';
import { sendNotificationsJob } from '~/server/jobs/send-notifications';
import { sendWebhooksJob } from '~/server/jobs/send-webhooks';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { redis } from '~/server/redis/client';
import { removeDisconnectedImages } from '~/server/jobs/remove-disconnected-images';
import { pushDiscordMetadata } from '~/server/jobs/push-discord-metadata';
import { applyDiscordRoles } from '~/server/jobs/apply-discord-roles';
import { Job } from '~/server/jobs/job';
import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { disabledVotedTags } from '~/server/jobs/disabled-voted-tags';
import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { resetToDraftWithoutRequirements } from '~/server/jobs/reset-to-draft-without-requirements';
import { isProd } from '~/env/other';
import { applyContestTags } from '~/server/jobs/apply-contest-tags';
import { applyNsfwBaseline } from '~/server/jobs/apply-nsfw-baseline';
import { leaderboardJobs } from '~/server/jobs/prepare-leaderboard';
import { deliverLeaderboardCosmetics } from '~/server/jobs/deliver-leaderboard-cosmetics';
import { refreshImageGenerationCoverage } from '~/server/jobs/refresh-image-generation-coverage';
import { ingestImages, removeBlockedImages } from '~/server/jobs/image-ingestion';
import { tempRecomputePostMetrics } from '~/server/jobs/temp-recompute-post-metrics';
import { tempScanFilesMissingHashes } from '~/server/jobs/temp-scan-files-missing-hashes';
import { processScheduledPublishing } from '~/server/jobs/process-scheduled-publishing';
import { metricJobs } from '~/server/jobs/update-metrics';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { env } from '~/env/server.mjs';

export const jobs: Job[] = [
  scanFilesJob,
  processImportsJob,
  sendNotificationsJob,
  sendWebhooksJob,
  addOnDemandRunStrategiesJob,
  deliverPurchasedCosmetics,
  deliverLeaderboardCosmetics,
  removeDisconnectedImages,
  pushDiscordMetadata,
  applyVotedTags,
  disabledVotedTags,
  removeOldDrafts,
  resetToDraftWithoutRequirements,
  applyContestTags,
  ...applyDiscordRoles,
  applyNsfwBaseline,
  ...leaderboardJobs,
  ingestImages,
  removeBlockedImages,
  tempRecomputePostMetrics,
  tempScanFilesMissingHashes,
  processScheduledPublishing,
  refreshImageGenerationCoverage,
  ...metricJobs,
  ...searchIndexJobs,
];

const log = createLogger('jobs', 'green');

export default WebhookEndpoint(async (req, res) => {
  const { run: runJob } = querySchema.parse(req.query);

  // Get requested job
  const job = jobs.find((x) => x.name === runJob);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  const { name, run, options } = job;

  if (await isLocked(name)) return res.status(200).json({ ok: true, error: 'Job already running' });

  const jobStart = Date.now();
  const axiom = req.log.with({ scope: 'job', name, pod: env.PODNAME });
  let result: MixedObject | void;
  try {
    log(`${name} starting`);
    axiom.info(`starting`);
    await lock(name, options.lockExpiration);
    result = await run();
    log(`${name} successful: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`);
    axiom.info('success', { duration: Date.now() - jobStart });
    res.status(200).json({ ok: true, pod: env.PODNAME, result: result ?? null });
  } catch (e) {
    log(`${name} failed: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`, e);
    axiom.error(`failed`, { duration: Date.now() - jobStart, error: e });
    res.status(500).json({ ok: false, pod: env.PODNAME, error: e });
  } finally {
    await unlock(name);
  }
});

const querySchema = z.object({
  run: z.string().optional(),
});

async function isLocked(name: string) {
  if (!isProd) return false;
  return (await redis?.get(`job:${name}`)) === 'true';
}

async function lock(name: string, lockExpiration: number) {
  if (!isProd) return;
  await redis?.set(`job:${name}`, 'true', { EX: lockExpiration });
}

async function unlock(name: string) {
  if (!isProd) return;
  await redis?.del(`job:${name}`);
}
