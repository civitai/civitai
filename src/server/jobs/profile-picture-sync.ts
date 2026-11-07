import { runProfilePictureSync } from '~/server/services/profile-picture-hold.service';
import { createJob } from './job';

export const profilePictureSync = createJob('profile-picture-sync', '* * * * *', () =>
  runProfilePictureSync()
);
