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

const sendCsamReportsJob = createJob(
  'send-csam-reports',
  '0 */1 * * *',
  async () => {
    const reports = await getCsamsToReport();
    // wait for each process to finish before going to the next
    for (const report of reports) {
      try {
        await processCsamReport(report);
      } catch (e: any) {
        if (isDev) console.log(e);
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          subType: 'send-report',
          message: e.message,
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
      } catch (e: any) {
        logToAxiom({
          name: 'csam-report',
          type: 'error',
          subType: 'archive-data',
          message: e.message,
        });
      }
    }
  },
  { dedicated: true }
);

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
