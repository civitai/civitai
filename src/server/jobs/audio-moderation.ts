import { createJob } from '~/server/jobs/job';
import { processAudioModerationQueue } from '~/server/services/audio-moderation.service';

export const audioModeration = createJob('audio-moderation', '* * * * *', (ctx) =>
  processAudioModerationQueue(() => ctx.checkIfCanceled())
);
