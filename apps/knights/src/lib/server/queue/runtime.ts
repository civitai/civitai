import { applyConsensusToMainApp } from './main-app';
import type { QueueDeps } from './queue.service';

export const queueDeps: QueueDeps = {
  applyConsensus: applyConsensusToMainApp,
  now: () => new Date(),
};
