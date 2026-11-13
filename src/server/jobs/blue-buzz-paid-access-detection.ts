import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import {
  defaultClickhouse,
  type RingThresholds,
} from '~/server/services/blue-buzz-paid-access-detection/detect';
import {
  runBluePaidAccessDetection,
  type RunDeps,
  type RunResult,
} from '~/server/services/blue-buzz-paid-access-detection/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

type ThresholdEnv = Pick<
  typeof env,
  | 'BLUE_PAID_ACCESS_RING_WINDOW_DAYS'
  | 'BLUE_PAID_ACCESS_RING_MIN_BUYERS'
  | 'BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT'
>;

export const ringThresholdsFromEnv = (e: ThresholdEnv): RingThresholds => ({
  windowDays: e.BLUE_PAID_ACCESS_RING_WINDOW_DAYS,
  minBuyers: e.BLUE_PAID_ACCESS_RING_MIN_BUYERS,
  minSharePct: e.BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT,
});

/** The run the job performs, with the environment and the run function injectable for tests. */
export const runBluePaidAccessJob = (
  e: ThresholdEnv = env,
  run: (deps: RunDeps) => Promise<RunResult> = runBluePaidAccessDetection
) =>
  run({
    ch: defaultClickhouse(),
    thresholds: ringThresholdsFromEnv(e),
    sendReport: (report) => moderatorApp.abuseReport(report),
    now: () => new Date(),
    log: (name, data) =>
      void logToAxiom({
        type: name.endsWith('-reported') ? 'info' : 'warning',
        name,
        ...data,
      }).catch(() => undefined),
  });

/** Keep in step with RUN_INTERVAL_HOURS (detect.ts). */
export const bluePaidAccessDetection = createJob(
  'blue-buzz-paid-access-detection',
  '30 7 * * *',
  async () => runBluePaidAccessJob(),
  { lockExpiration: 10 * 60 }
);
