import { createJob } from './job';
import { healStalledTrainingDataScans } from '~/server/services/training-data-scan.service';

// A run copies at most two waves of zips, each bounded at about 12 minutes by the copy deadlines. The lock
// outlasts that and survives a scheduler disconnect, so a second run never re-claims an unstarted row.
export const trainingDataScanHealJob = createJob(
  'training-data-scan-heal',
  '*/15 * * * *',
  healStalledTrainingDataScans,
  { lockExpiration: 30 * 60, keepLockOnDisconnect: true }
);
