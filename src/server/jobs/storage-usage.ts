import {
  runMediaStorageUsage,
  runNightlyStorageUsage,
} from '~/server/services/storage-usage.service';
import { createJob } from './job';

export const storageUsageNightlyJob = createJob(
  'storage-usage-nightly',
  '0 4 * * *',
  () => runNightlyStorageUsage(),
  { lockExpiration: 60 * 60 }
);

export const storageUsageMediaJob = createJob(
  'storage-usage-media',
  '* * * * *',
  () => runMediaStorageUsage(),
  { lockExpiration: 10 * 60 }
);
