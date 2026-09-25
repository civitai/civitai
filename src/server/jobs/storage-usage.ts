import {
  USER_ID_RANGE_WIDTH,
  claimMediaRollups,
  fetchNightlyUsage,
  getMaxUserId,
  sumUserMedia,
  writeDailySnapshots,
  writeMediaUsage,
  writeNightlyUsage,
} from '~/server/services/storage-usage.service';
import { createJob } from './job';

export const storageUsageNightlyJob = createJob(
  'storage-usage-nightly',
  '0 4 * * *',
  async () => {
    const maxUserId = await getMaxUserId();
    let ranges = 0;
    let rows = 0;
    for (let lo = 0; lo <= maxUserId; lo += USER_ID_RANGE_WIDTH) {
      const hi = lo + USER_ID_RANGE_WIDTH;
      const usage = await fetchNightlyUsage(lo, hi);
      await writeNightlyUsage(lo, hi, usage);
      ranges++;
      rows += usage.length;
    }
    await writeDailySnapshots();
    return { ranges, rows };
  },
  { lockExpiration: 60 * 60 }
);

export const storageUsageMediaJob = createJob(
  'storage-usage-media',
  '* * * * *',
  async () => {
    const userIds = await claimMediaRollups();
    const failed: number[] = [];
    for (const userId of userIds) {
      try {
        const rows = await sumUserMedia(userId);
        await writeMediaUsage(userId, rows);
      } catch (e) {
        failed.push(userId);
        console.error(`storage-usage-media: user ${userId} failed`, e);
      }
    }
    if (failed.length) throw new Error(`storage-usage-media: ${failed.length} rollup(s) failed`);
    return { processed: userIds.length };
  },
  { lockExpiration: 10 * 60 }
);
