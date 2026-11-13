import {
  processComFaceVersionText,
  sweepComFaceVersionText,
} from '~/server/services/model-com-face-version-text.service';
import { createJob } from './job';

export const comFaceVersionTextJob = createJob('com-face-version-text', '* * * * *', () =>
  processComFaceVersionText()
);

export const comFaceVersionTextSweepJob = createJob(
  'com-face-version-text-sweep',
  '17 * * * *',
  async () => ({ queued: (await sweepComFaceVersionText()).length })
);
