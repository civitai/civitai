import { legacyExpMirror } from '../progression/legacy-exp';
import { getSysRedis } from '../redis';
import { applyConsensusToMainApp } from './main-app';
import type { QueueDeps } from './queue.service';

export const queueDeps: QueueDeps = {
  applyConsensus: applyConsensusToMainApp,
  now: () => new Date(),
  mirrorXp: legacyExpMirror(getSysRedis),
};
