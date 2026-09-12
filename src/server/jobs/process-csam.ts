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
 * One `archive-csam-reports` pass, measured end to end for a report covering a large image library.
 *
 * Rounded up from a SINGLE observation. It is a sighting, not a distribution, and it is a
 * single-report time while a tick archives the whole outstanding batch serially — so treat it as a
 * floor on how long a pass can take, never as an expected value. Named and exported so the lock
 * below is checkably sized against something instead of being a bare literal.
 */
export const CSAM_ARCHIVE_MEASURED_PASS_SECONDS = 80 * 60;

/**
 * How long `archive-csam-reports` may hold its run lock, overriding `createJob`'s 5-minute default.
 *
 * WHY AN OVERRIDE. The run-jobs route hard-caps the hold at exactly this value and then releases
 * the lock while the run keeps going (`acquireLock`, `src/pages/api/webhooks/run-jobs/[[...run]].ts`).
 * At the inherited 300s against an hourly cron, an archive that runs longer than five minutes — the
 * ordinary case for a report covering a large image library, one pass having been measured at
 * CSAM_ARCHIVE_MEASURED_PASS_SECONDS — self-releases about five minutes in, and a later tick is then
 * free to start a second, competing archive of the same report from scratch, re-fetching everything
 * the first pass is still fetching. Same mitigation, same reason, as `blurb-fanout` and
 * `bot-account-detection`.
 *
 * 🔴 `dedicated: true` DOES NOT CLOSE THIS, and its name invites the opposite reading. Nothing in
 * the tree reads `options.dedicated` (see `JobOptions`) — it is declared, set on a handful of jobs,
 * serialised to the scheduler and discarded there. It is inert. It would not close this even if it
 * were honoured: restricting the job to one pod says nothing about that pod starting it again on
 * the next tick.
 *
 * WHY THE LOCK IS ALSO HELD PAST A CLIENT DISCONNECT (`keepLockOnDisconnect`). Without that flag
 * this constant governs nothing here. The caller holds the trigger request open under its own
 * client-side timeout and retries when that fires; a pass longer than the timeout therefore loses
 * its socket, the route's close handler runs, and the default release throws the entire budget away
 * — long before four hours could matter — leaving the retry free to start the competing pass above.
 * The job deliberately does NOT poll `checkIfCanceled` and must not be made to: a pass of the
 * measured length necessarily outlives the caller's timeout and finishes only because this job
 * keeps running after the disconnect, so a cancelling version would be killed at every retry's
 * timeout and never complete a long archive at all. The lock, not cancellation, is the mitigation —
 * and it has to survive the disconnect in order to be one.
 *
 * WHY THIS VALUE — THE COST, BOTH DIRECTIONS.
 * Too short and the duplicate-run hazard returns. The absolute floor is the hourly cron period; the
 * working floor is well above it, because a tick archives the whole outstanding batch serially and
 * libraries larger than the measured one exist.
 * Too long is now a REAL cost, and `keepLockOnDisconnect` is what makes it real: a run that is alive
 * but wedged holds this lock for its full duration, and archival does not resume until it expires.
 * A clean finish still releases immediately, and a pod that DIES does not pay it at all — the redis
 * key carries a ~10s TTL refreshed by an in-process interval, so a crashed pod's lock lapses within
 * seconds regardless of this value. Four hours sits a few multiples above the measured pass while
 * staying bounded low enough that a wedge clears itself rather than needing a human.
 *
 * 🔴 The exact figure is a JUDGEMENT CALL, not a derivation: one measured pass is not a duration
 * distribution, and a single-report time is not a per-tick batch total. What would replace it with
 * an arithmetic bound is a per-report archive-duration histogram — p99 against library size — plus
 * that batch total. Until that exists, read 4h as a ceiling sized off one observation, not as a
 * reservation.
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
  // `keepLockOnDisconnect` is load-bearing, not a refinement: without it the close handler releases
  // the lock the moment the caller's request times out, and `lockExpiration` never gets to govern
  // anything. `dedicated` stays as a declaration of intent only — nothing reads it. See
  // CSAM_ARCHIVE_JOB_LOCK_SECONDS above for the whole argument, including what the held lock costs.
  {
    dedicated: true,
    lockExpiration: CSAM_ARCHIVE_JOB_LOCK_SECONDS,
    keepLockOnDisconnect: true,
  }
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
