import { blobIdFromAir } from '$lib/orchestrator-core';
import { getRunDataset } from './orchestrator';

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
// A dataset grid asks once per image; one read of the run answers them all.
const cache = new Map<string, { at: number; keys: Promise<Set<string>> }>();

/** The blob keys of `workflowId`'s dataset, read with the caller's token (empty if the run is not
 *  theirs). A failed read is not kept. */
export function runDatasetKeys(
  token: string,
  userId: number,
  workflowId: string
): Promise<Set<string>> {
  const key = `${userId}\n${workflowId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.keys;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const keys = getRunDataset(token, workflowId).then(
    (items) => new Set(items.map((i) => blobIdFromAir(i.air))),
    (err) => {
      cache.delete(key);
      throw err;
    }
  );
  cache.set(key, { at: Date.now(), keys });
  return keys;
}
