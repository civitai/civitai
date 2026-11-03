import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import {
  defaultClickhouse,
  type RingThresholds,
} from '~/server/services/blue-buzz-paid-access-detection/detect';
import { runBluePaidAccessDetection } from '~/server/services/blue-buzz-paid-access-detection/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

export const ringThresholdsFromEnv = (
  e: Pick<
    typeof env,
    | 'BLUE_PAID_ACCESS_RING_WINDOW_DAYS'
    | 'BLUE_PAID_ACCESS_RING_MIN_BUYERS'
    | 'BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT'
  >
): RingThresholds => ({
  windowDays: e.BLUE_PAID_ACCESS_RING_WINDOW_DAYS,
  minBuyers: e.BLUE_PAID_ACCESS_RING_MIN_BUYERS,
  minSharePct: e.BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT,
});

/** The cron must stay in step with `RUN_INTERVAL_HOURS`; `/api/internal/get-jobs` publishes it to the
 *  external scheduler, so it is the deployment. */
export const bluePaidAccessDetection = createJob(
  'blue-buzz-paid-access-detection',
  '30 7 * * *',
  async () =>
    runBluePaidAccessDetection({
      ch: defaultClickhouse(),
      thresholds: ringThresholdsFromEnv(env),
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (name, data) =>
        void logToAxiom({
          type: name.endsWith('-reported') ? 'info' : 'warning',
          name,
          ...data,
        }).catch(() => undefined),
    }),
  { lockExpiration: 10 * 60 }
);
