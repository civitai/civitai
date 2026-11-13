import { createJob } from './job';
import { sweepAcceptedCrucibleEntries } from '~/server/services/crucible-entry-accepted';

export const crucibleEntryAcceptedJob = createJob('crucible-entry-accepted', '*/2 * * * *', () =>
  sweepAcceptedCrucibleEntries()
);
