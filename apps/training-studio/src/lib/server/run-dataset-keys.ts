import { workflowToDetail } from '$lib/data/trainingRows';
import { editSourceAirs } from '$lib/edit-helpers-core';
import { blobIdFromAir, readWorkflow } from '$lib/orchestrator-core';
import { orchestratorClient } from './orchestrator';

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
// A dataset grid asks once per image; one read of the run answers them all.
const cache = new Map<string, { at: number; keys: Set<string> }>();

/** The blob keys `workflowId` may serve as dataset images: a training run's dataset, or an image
 *  edit's starting images. Read with the caller's token, so another user's run gives none. */
export async function runDatasetKeys(
  token: string,
  userId: number,
  workflowId: string
): Promise<Set<string>> {
  const key = `${userId}\n${workflowId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.keys;

  const { data, error } = await readWorkflow(orchestratorClient(token), workflowId);
  if (!data) {
    if (error?.status === 404) return new Set();
    throw new Error(`dataset keys: workflow read failed (${error?.detail ?? 'no data returned'})`);
  }
  const airs = [
    ...(workflowToDetail(data)?.dataset ?? []).map((i) => i.air),
    ...editSourceAirs(data),
  ];
  const keys = new Set(airs.map(blobIdFromAir));
  // An empty answer may be a run mid-transition; only a real dataset is kept.
  if (keys.size > 0) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), keys });
  }
  return keys;
}
