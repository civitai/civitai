import { createJob } from './job';
import { repackFinals } from '~/server/services/creator-service-deal-repack.service';
import {
  deleteEntryScanCopies,
  settleEntryScans,
  settleFinals,
  settleMalwareScans,
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
 * Unpacks delivered Finals, builds the archive a buyer downloads, and settles their scans, polling
 * the malware scan rather than waiting for a callback (see the notes in the unpack and repack
 * services). One archive per step per run: each is streamed through
 * memory.
 *
 * Not behind the `creatorServices` flag, for the same reason as the preview job.
 */
export const creatorServiceUnpackJob = createJob(
  'creator-service-unpack',
  '* * * * *',
  async (jobContext) => {
    const shouldStop = () => jobContext.status !== 'running';
    const unpacked = await unpackFinals({ shouldStop });
    jobContext.checkIfCanceled();
    const repacked = await repackFinals({ shouldStop });
    jobContext.checkIfCanceled();
    const entries = await settleEntryScans();
    jobContext.checkIfCanceled();
    const scans = await settleMalwareScans({ shouldStop });
    jobContext.checkIfCanceled();
    const finals = await settleFinals();
    jobContext.checkIfCanceled();
    const copiesDeleted = await deleteEntryScanCopies();
    return { unpacked, repacked, ...entries, ...scans, ...finals, copiesDeleted };
  },
  { lockExpiration: 40 * 60 }
);

export const creatorServiceDealFileJobs = [creatorServiceDealFilesJob, creatorServiceUnpackJob];
