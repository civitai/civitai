import { env } from '$env/dynamic/private';
import { legacyExpMirror } from '../progression/legacy-exp';
import { getSysRedis } from '../redis';
import { resetDeps } from '../smites/runtime';
import type { ApprenticeDeps } from './apprenticeship.service';
import { apprenticeSettings } from './config';

export const apprenticeDeps: ApprenticeDeps = {
  now: () => new Date(),
  mirrorXp: legacyExpMirror(getSysRedis),
  resetPlayer: resetDeps.resetPlayer,
  // Read per answer so a changed environment is picked up without a rebuild.
  settings: () => apprenticeSettings(env),
};
