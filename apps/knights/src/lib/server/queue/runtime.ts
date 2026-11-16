import { legacyExpMirror } from '../progression/legacy-exp';
import { getSysRedis } from '../redis';
import { applyConsensusToMainApp } from './main-app';
import type { QueueDeps } from './queue.service';
import { limitsSource } from '../vote-limits/runtime';

export const queueDeps: QueueDeps = {
  applyConsensus: applyConsensusToMainApp,
  now: () => new Date(),
  mirrorXp: legacyExpMirror(getSysRedis),
  // The ledger backstop follows the live limits the gate last read.
  get voteLimits() {
    return limitsSource.current();
  },
};
