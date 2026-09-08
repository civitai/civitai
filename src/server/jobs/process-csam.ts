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
  { dedicated: true }
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
