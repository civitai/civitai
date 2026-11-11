import { createJob } from './job';
import { healStalledTrainingDataScans } from '~/server/services/training-data-scan.service';

export const trainingDataScanHealJob = createJob(
  'training-data-scan-heal',
  '*/15 * * * *',
  healStalledTrainingDataScans
);
