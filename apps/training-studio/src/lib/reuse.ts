import { goto } from '$app/navigation';

export interface ReuseItem {
  air: string;
  caption: string;
  name: string;
  previewUrl: string;
}

/** The dataset-blob proxy URL for a run's blob — the tile preview for a reused item. */
export function datasetPreview(air: string, workflowId: string): string {
  return `/api/dataset-blob?air=${encodeURIComponent(air)}&workflowId=${encodeURIComponent(
    workflowId
  )}`;
}

/** Map a fetched run dataset to reuse items (with proxy previews) for a given source run. */
export function toReuseItems(
  dataset: { air: string; caption: string }[],
  workflowId: string
): ReuseItem[] {
  return dataset.map((d, i) => ({
    air: d.air,
    caption: d.caption,
    name: `image ${i + 1}`,
    previewUrl: datasetPreview(d.air, workflowId),
  }));
}

/** Store the dataset for the new-flow hand-off and navigate there (the Select→Data flow pre-fills it). */
export function handoffReuse(items: ReuseItem[]) {
  sessionStorage.setItem('ts:reuse-dataset', JSON.stringify(items));
  void goto('/new');
}

/** Remix: fetch a run's dataset and start a new training pre-loaded with it (reuse the blob airs — no
 *  re-upload). No-op if the run has no blob-backed dataset. */
export async function remixFromRun(workflowId: string): Promise<void> {
  const res = await fetch(`/api/run-dataset?id=${encodeURIComponent(workflowId)}`);
  if (!res.ok) return;
  const dataset = (await res.json()) as { air: string; caption: string }[];
  if (dataset.length === 0) return;
  handoffReuse(toReuseItems(dataset, workflowId));
}

/** Keep training: continue a run from one of its checkpoints, adding `addEpochs` epochs. Returns the new
 *  run id, or throws with a user-facing message. */
export async function continueRun(
  workflowId: string,
  fromEpoch: number,
  addEpochs: number
): Promise<string> {
  const res = await fetch('/api/continue-training', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, fromEpoch, addEpochs }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || 'Could not start training.');
  }
  return ((await res.json()) as { workflowId: string }).workflowId;
}
