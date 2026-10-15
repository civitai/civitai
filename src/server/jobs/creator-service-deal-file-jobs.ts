import { createJob } from './job';
import {
  deleteScanCopies,
  publishPreviews,
  settlePreviewScans,
  startPreviewScans,
} from '~/server/services/creator-service-deal-file.service';

/**
 * Moves every uploaded preview one step along its way: scan copy, verdict, mark and publish, then
 * clean up the copy (see the pipeline notes in the file service). Image work (sharp) runs here, on
 * the pods that serve `run-jobs`, never inside a request. Small batches: a 60-frame animation
 * costs seconds of CPU, and the pods share other cron work.
 *
 * Not behind the `creatorServices` flag: a delivery already made while it was on must still finish.
 */
export const creatorServiceDealFilesJob = createJob(
  'creator-service-deal-files',
  '* * * * *',
  async (jobContext) => {
    const started = await startPreviewScans({ limit: 3 });
    jobContext.checkIfCanceled();
    const verdicts = await settlePreviewScans();
    jobContext.checkIfCanceled();
    const published = await publishPreviews({ limit: 3 });
    jobContext.checkIfCanceled();
    const copiesDeleted = await deleteScanCopies();
    return { started, ...verdicts, published, copiesDeleted };
  },
  { lockExpiration: 10 * 60 }
);

export const creatorServiceDealFileJobs = [creatorServiceDealFilesJob];
