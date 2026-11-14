import { pgDbReadLong } from '~/server/db/pgDb';
import {
  computeMilestoneRarity,
  storeMilestoneRarity,
} from '~/server/services/creator-milestone-rarity.service';
import { createJob } from './job';

// After the nightly score update (23:55) and milestone grants (01:20), so it counts tonight's grants.
export const countCreatorMilestoneRarity = createJob(
  'count-creator-milestone-rarity',
  '40 2 * * *',
  async () => {
    const rarity = await computeMilestoneRarity(pgDbReadLong);
    await storeMilestoneRarity(rarity);
    return { creators: rarity.creators, milestones: Object.keys(rarity.holders).length };
  },
  { lockExpiration: 30 * 60, queue: 'metrics' }
);
