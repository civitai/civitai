import { keyHashSlots } from '@civitai/redis/key-slot';

/**
 * What the cache cluster does with a MULTI, a script or a multi-key command whose keys are not all
 * in one hash slot: refuses it with CROSSSLOT. A fake cluster calls this with the keys of each such
 * request, so a test fails on a cross-slot shape the way production would.
 */
export function rejectCrossSlot(keys: readonly string[]) {
  if (keyHashSlots(keys).length > 1)
    throw new Error(`CROSSSLOT Keys in request don't hash to the same slot: ${keys.join(' ')}`);
}
