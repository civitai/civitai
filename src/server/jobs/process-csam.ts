import { isDev, isProd } from '~/env/other';
import { createJob } from './job';
import {
  archiveCsamDataForReport,
  getCsamsToArchive,
  getCsamsToRemoveContent,
  getCsamsToReport,
  processCsamReport,
} from '~/server/services/csam.service-new';
import { logToAxiom } from '~/server/logging/client';

/**
 * Reads a message off an unknown thrown value without assuming it has one.
 *
 * 🔴 This is a batch-integrity guard, not a formatting nicety. The loops below catch per report
 * so that one bad report cannot stop the rest, but `e.message` on a non-object rejection throws
 * a `TypeError` *inside the catch block*, where nothing catches it — it escapes the `for` loop
 * and abandons every remaining report in the batch. `uploadStream` used to reject with a bare
 * `reject()`, i.e. `undefined`, which is exactly that case. Both ends are fixed; this is the end
 * that holds for any future thrower.
 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

const sendCsamReportsJob = createJob(
  'send-csam-reports',
  '0 */1 * * *',
  async () => {
    const reports = await getCsamsToReport();
    // wait for each process to finish before going to the next
    for (const report of reports) {
      try {
        await processCsamReport(report);
      } catch (e) {
        if (isDev) console.log(e);
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          subType: 'send-report',
          message: errorMessage(e),
        });
      }
    }
  },
  { dedicated: true }
);

/**
 * Lock hold for `archive-csam-reports`, overriding `createJob`'s 5-minute default.
 *
 * WHY AN OVERRIDE AT ALL. The run-jobs route hard-caps the lock hold at exactly this value and
 * then RELEASES the lock while the run keeps going (`acquireLock` in the run-jobs webhook). At the
 * inherited 300s against an hourly cron, an archive that runs longer than five minutes — the
 * normal case for a reported user with a very large image library, one such pass having been
 * measured end to end at roughly 80 minutes — self-releases about five minutes in, and every
 * subsequent hourly tick is then free to start a second, concurrent archive of the same report
 * from scratch. That has happened in production: concurrency reached three simultaneous passes,
 * each re-downloading the same evidence, and the only thing that stopped it was an operator
 * suppressing the later ticks by hand. `dedicated: true` does not help — it pins the job to one
 * pod, it does not stop that pod starting the job again on the next tick. Same mitigation, same
 * reason, as `blurb-fanout` and `bot-account-detection`.
 *
 * WHY THIS VALUE — THE TRADE-OFF, BOTH DIRECTIONS.
 * Too short and the duplicate-run hazard above simply returns. The floor for closing it at all is
 * the hourly cron period, and the working floor is well above that: a tick archives the whole
 * outstanding batch serially, not one report, and libraries substantially larger than the
 * ~80-minute one exist in the population.
 * Too long costs less than it looks. A clean finish releases the lock immediately, a client
 * disconnect releases it, and a pod that dies outright does NOT hold it for this long — the redis
 * key carries a ~10s TTL refreshed by an in-process interval, so a dead pod's lock lapses within
 * seconds. The only case that pays the full value is a run that is alive but wedged; there the
 * cost is real, and it is that archival stalls until this expires.
 * Four hours sits a few multiples above the measured pass while staying bounded low enough that
 * such a wedge clears itself within a shift instead of requiring a human.
 *
 * 🔴 The exact figure is a JUDGEMENT CALL, not a derivation. What exists is one measured
 * ~80-minute pass plus a count of accounts above that size class; that is not a duration
 * distribution, and a batch total is not a single-report time. What would replace this with an
 * arithmetic bound is a per-report archive-duration histogram — p99 against library size, and the
 * per-tick batch total. Until that exists, read 4h as a ceiling sized off a single observation,
 * not as a reservation.
 */
export const CSAM_ARCHIVE_JOB_LOCK_SECONDS = 4 * 60 * 60;

const archiveCsamReportDataJob = createJob(
  'archive-csam-reports',
  '20 */1 * * *',
  async () => {
    const reports = await getCsamsToArchive();
    // wait for each process to finish before going to the next
    for (const report of reports) {
      try {
        await archiveCsamDataForReport(report);
      } catch (e) {
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          subType: 'archive-data',
          message: errorMessage(e),
        });
      }
    }
  },
  // `dedicated` stays: it is the one-pod restriction, and it is orthogonal to the lock — see
  // CSAM_ARCHIVE_JOB_LOCK_SECONDS above for why the inherited 300s default is the wrong hold.
  { dedicated: true, lockExpiration: CSAM_ARCHIVE_JOB_LOCK_SECONDS }
);

// Unfinished, deliberately not in `csamJobs` — the removal step has never been written, so
// `contentRemovedAt` is never set and `remove-blocked-images` is currently the only thing that
// deletes CSAM media. See docs/csam-retention-followups.md before wiring this up.
const removeContentForCsamReportsJob = createJob(
  'remove-csam-content',
  '40 */1 * * *',
  async () => {
    if (!isProd) return;
    const reports = await getCsamsToRemoveContent();
    // wait for each process to finish before going to the next
    for (const report of reports) {
      // await archiveCsamDataForReport(report);
    }
  },
  { dedicated: true }
);

export const csamJobs = [sendCsamReportsJob, archiveCsamReportDataJob];
