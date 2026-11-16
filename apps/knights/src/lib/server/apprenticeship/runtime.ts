import { legacyExpMirror } from '../progression/legacy-exp';
import { getSysRedis } from '../redis';
import { resetDeps } from '../smites/runtime';
import type { ApprenticeDeps } from './apprenticeship.service';

export const apprenticeDeps: ApprenticeDeps = {
  now: () => new Date(),
  mirrorXp: legacyExpMirror(getSysRedis),
  resetPlayer: resetDeps.resetPlayer,
};
