import { createJob } from './job';
import {
  deleteEntryScanCopies,
  settleEntryScans,
  settleFinals,
  unpackFinals,
} from '~/server/services/creator-service-deal-unpack.service';
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

/**
 * Unpacks delivered Finals and settles their scans (see the notes in the unpack service). One
 * archive per run: it is streamed through memory.
 *
 * Not behind the `creatorServices` flag, for the same reason as the preview job.
 */
export const creatorServiceUnpackJob = createJob(
  'creator-service-unpack',
  '* * * * *',
  async (jobContext) => {
    const unpacked = await unpackFinals({ shouldStop: () => jobContext.status !== 'running' });
    jobContext.checkIfCanceled();
    const entries = await settleEntryScans();
    jobContext.checkIfCanceled();
    const finals = await settleFinals();
    jobContext.checkIfCanceled();
    const copiesDeleted = await deleteEntryScanCopies();
    return { unpacked, ...entries, ...finals, copiesDeleted };
  },
  { lockExpiration: 40 * 60 }
);

export const creatorServiceDealFileJobs = [creatorServiceDealFilesJob, creatorServiceUnpackJob];
