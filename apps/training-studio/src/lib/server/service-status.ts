import { REDIS_SYS_KEYS } from '@civitai/redis';
import { parseServiceStatus, type TrainingServiceStatus } from '$lib/service-status-core';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';

const READ_DEADLINE_MS = 2000;

/** Shown when the status cannot be read and this process has never read it. */
export const TRAINING_STATUS_UNKNOWN_MESSAGE =
  'Training is temporarily unavailable. Please try again in a few minutes.';

// The last status this process read. The "training paused" flag is a moderator control on a paid
// submit, so a failed read must not turn an operator's "paused" back into "available". No age
// bound: while the store is unreachable its value cannot change either.
let lastKnown: TrainingServiceStatus | undefined;

async function readRaw(): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getSysRedis().hGet<string>(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.TRAINING.STATUS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`training status read timed out after ${READ_DEADLINE_MS}ms`)),
          READ_DEADLINE_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The same sys-redis value the main app's `training.getStatus` serves. On a failed or slow read
 *  it answers with the last status this process read and, when there is none, treats training as
 *  paused with TRAINING_STATUS_UNKNOWN_MESSAGE. A stored value that is not valid JSON still reads
 *  as the schema default (available): that is a bad value, not an outage. */
export async function getTrainingServiceStatus(): Promise<TrainingServiceStatus> {
  let raw: unknown;
  try {
    raw = await readRaw();
  } catch (err) {
    void logToAxiom({
      name: 'training-studio-status-read',
      type: 'error',
      message: 'training status read failed',
      served: lastKnown ? 'last-known-good' : 'paused',
      error: safeError(err),
    });
    return (
      lastKnown ?? {
        available: false,
        message: TRAINING_STATUS_UNKNOWN_MESSAGE,
        blockedModels: [],
        blockedModelReasons: {},
      }
    );
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(String(raw)) : null;
  } catch {
    parsed = null;
  }
  const status = parseServiceStatus(parsed);
  lastKnown = status;
  return status;
}
