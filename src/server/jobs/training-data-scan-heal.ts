import { createJob } from './job';
import { healStalledTrainingDataScans } from '~/server/services/training-data-scan.service';

// A claimed zip is not claimed again for an hour, so overlapping runs never copy the same one. The lock,
// kept through a scheduler disconnect, keeps runs from overlapping at all in the usual case.
export const trainingDataScanHealJob = createJob(
  'training-data-scan-heal',
  '*/15 * * * *',
  healStalledTrainingDataScans,
  { lockExpiration: 30 * 60, keepLockOnDisconnect: true }
);
