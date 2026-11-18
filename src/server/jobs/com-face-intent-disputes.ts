import { processComFaceIntentDisputes } from '~/server/services/model-com-face-intent-dispute.service';
import { createJob } from './job';

/** Owners' disputes of a listing intent lock, re-judged before a moderator sees them. */
export const comFaceIntentDisputesJob = createJob(
  'com-face-intent-disputes',
  '*/10 * * * *',
  processComFaceIntentDisputes
);
