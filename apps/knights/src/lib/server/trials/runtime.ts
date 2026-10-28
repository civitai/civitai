import { randomInt } from 'node:crypto';
import type { TrialDeps } from './trials.service';

export const trialDeps: TrialDeps = {
  now: () => new Date(),
  newSeed: () => randomInt(2 ** 31),
};
