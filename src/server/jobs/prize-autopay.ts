import { createJob } from './job';
import { autoPayPrizes } from '~/server/services/prize.service';

export const prizeAutoPayJob = createJob('prize-autopay', '17 * * * *', async () => {
  return autoPayPrizes();
});
