import cronParser from 'cron-parser';
import dayjs from 'dayjs';
import { z } from 'zod';

import { addOnDemandRunStrategiesJob } from '~/server/jobs/add-on-demand-run-strategies';
import { deliverPurchasedCosmetics } from '~/server/jobs/deliver-purchased-cosmetics';
import { processImportsJob } from '~/server/jobs/process-imports';
import { scanFilesJob } from '~/server/jobs/scan-files';
import { selectFeaturedImages } from '~/server/jobs/select-featured-images';
import { sendNotificationsJob } from '~/server/jobs/send-notifications';
import { sendWebhooksJob } from '~/server/jobs/send-webhooks';
import { updateMetricsJob } from '~/server/jobs/update-metrics';
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
import { updateMetricsModelJob } from '~/server/jobs/update-metrics-models';
import { applyContestTags } from '~/server/jobs/apply-contest-tags';
import { applyNsfwBaseline } from '~/server/jobs/apply-nsfw-baseline';
import { leaderboardJobs } from '~/server/jobs/prepare-leaderboard';
import { deliverLeaderboardCosmetics } from '~/server/jobs/deliver-leaderboard-cosmetics';
import { ingestImages } from '~/server/jobs/ingest-images';
import { tempRecomputePostMetrics } from '~/server/jobs/temp-recompute-post-metrics';
import { tempScanFilesMissingHashes } from '~/server/jobs/temp-scan-files-missing-hashes';

export const jobs: Job[] = [
  scanFilesJob,
  updateMetricsJob,
  updateMetricsModelJob,
  processImportsJob,
  sendNotificationsJob,
  sendWebhooksJob,
  addOnDemandRunStrategiesJob,
  deliverPurchasedCosmetics,
  deliverLeaderboardCosmetics,
  selectFeaturedImages,
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
  tempRecomputePostMetrics,
  tempScanFilesMissingHashes,
];

const log = createLogger('jobs', 'green');

export default WebhookEndpoint(async (req, res) => {
  const { run: runJob, wait } = querySchema.parse(req.query);
  const ran = [];
  const toRun = [];
  const alreadyRunning = [];
  const afterResponse = [];
  let result: MixedObject | void;

  const now = new Date();
  for (const { name, cron, run, options } of jobs) {
    if (runJob) {
      if (runJob !== name) continue;
    } else if (!isCronMatch(cron, now)) continue;

    if (await isLocked(name)) {
      log(`${name} already running`);
      alreadyRunning.push(name);
      continue;
    }

    const processJob = async () => {
      const jobStart = Date.now();
      const axiom = req.log.with({ scope: 'job', name });
      try {
        log(`${name} starting`);
        axiom.info(`starting`);
        lock(name, options.lockExpiration);
        const result = await run();
        log(`${name} successful: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`);
        axiom.info('success', { duration: Date.now() - jobStart });
        return result;
      } catch (e) {
        log(`${name} failed: ${((Date.now() - jobStart) / 1000).toFixed(2)}s`, e);
        axiom.error(`failed`, { duration: Date.now() - jobStart, error: e });
      } finally {
        unlock(name);
      }
    };

    if (options.shouldWait || wait) {
      result = await processJob();
      ran.push(name);
      // If this was the only job that got requested and we waited for the outcome, return the status
      if (runJob) break;
    } else {
      afterResponse.push(processJob);
      toRun.push(name);
    }
  }

  res.status(200).json(result ?? { ok: true, ran, toRun, alreadyRunning });
  await Promise.all(afterResponse.map((run) => run()));
});

// https://github.com/harrisiirak/cron-parser/issues/153#issuecomment-590099607
const cronScopes = ['minute', 'hour', 'day', 'month', 'weekday'] as const;
function isCronMatch(
  cronExpression: string,
  date: Date,
  scope: (typeof cronScopes)[number] = 'minute'
): boolean {
  const scopeIndex = cronScopes.indexOf(scope);
  const day = dayjs(date);

  try {
    const { fields } = cronParser.parseExpression(cronExpression);

    if (scopeIndex <= 0 && !(fields.minute as number[]).includes(day.minute())) return false;
    if (scopeIndex <= 1 && !(fields.hour as number[]).includes(day.hour())) return false;
    if (scopeIndex <= 2 && !(fields.dayOfMonth as number[]).includes(day.date())) return false;
    if (scopeIndex <= 3 && !(fields.month as number[]).includes(day.month() + 1)) return false;
    if (scopeIndex <= 4 && !(fields.dayOfWeek as number[]).includes(day.day())) return false;

    return true;
  } catch (e) {
    return false;
  }
}

const querySchema = z.object({
  run: z.string().optional(),
  wait: z.coerce.boolean().optional(),
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
