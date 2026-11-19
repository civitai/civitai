import { comVersionTextJobsEnabled } from '~/server/services/com-face-version-text-flag';
import {
  processComFaceVersionText,
  sweepComFaceVersionText,
} from '~/server/services/model-com-face-version-text.service';
import { createJob } from './job';

const SKIPPED = { skipped: 'com-face-version-text-jobs flag off' };

export const runComFaceVersionText = async () =>
  (await comVersionTextJobsEnabled()) ? processComFaceVersionText() : SKIPPED;

export const runComFaceVersionTextSweep = async () =>
  (await comVersionTextJobsEnabled())
    ? { queued: (await sweepComFaceVersionText()).length }
    : SKIPPED;

export const comFaceVersionTextJob = createJob(
  'com-face-version-text',
  '* * * * *',
  runComFaceVersionText
);

export const comFaceVersionTextSweepJob = createJob(
  'com-face-version-text-sweep',
  '17 * * * *',
  runComFaceVersionTextSweep
);
