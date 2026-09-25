import {
  MEDIA_JOB_LOCK_SECONDS,
  runMediaStorageUsage,
  runNightlyStorageUsage,
} from '~/server/services/storage-usage.service';
import { createJob } from './job';

export const storageUsageNightlyJob = createJob(
  'storage-usage-nightly',
  '0 4 * * *',
  () => runNightlyStorageUsage(),
  { lockExpiration: 60 * 60, keepLockOnDisconnect: true }
);

export const storageUsageMediaJob = createJob(
  'storage-usage-media',
  '* * * * *',
  (ctx) => runMediaStorageUsage({ isCanceled: () => ctx.status === 'canceled' }),
  { lockExpiration: MEDIA_JOB_LOCK_SECONDS, keepLockOnDisconnect: true }
);
