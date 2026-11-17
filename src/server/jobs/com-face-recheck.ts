import {
  COM_FACE_RUN_BUDGET_MS,
  processComFaceRechecks,
  processComFaceRestores,
} from '~/server/services/model-com-face-recheck.service';
import { createJob } from './job';

export const comFaceRecheckJob = createJob('com-face-recheck', '* * * * *', async () => {
  const startedAt = Date.now();
  const counts = await processComFaceRechecks();
  const restores = await processComFaceRestores(
    new Date(),
    COM_FACE_RUN_BUDGET_MS - (Date.now() - startedAt)
  );
  return { ...counts, restores };
});
