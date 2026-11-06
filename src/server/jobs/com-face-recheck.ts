import { processComFaceRechecks } from '~/server/services/model-com-face-recheck.service';
import { createJob } from './job';

export const comFaceRecheckJob = createJob('com-face-recheck', '* * * * *', async () => {
  const counts = await processComFaceRechecks();
  return counts;
});
