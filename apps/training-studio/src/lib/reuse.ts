import { backend, navigate } from '$lib/host';

export interface ReuseItem {
  air: string;
  caption: string;
  name: string;
  /** The run the blobs belong to — DataStep fetches each preview through it lazily. Reuse used to
   *  download EVERY dataset image up front, which read as an indefinite "Loading…" on any large or
   *  slow dataset; the `air` is what trains, so the hand-off must never wait on previews. */
  workflowId: string;
}

/** Dev-preview stand-ins are plain fetchable URLs; anything blob-backed needs the authenticated
 *  fetch through the seam (`backend().datasetBlob`). */
export function directDatasetUrl(air: string): string | null {
  const isAbsolute = air.startsWith('http://') || air.startsWith('https://');
  return isAbsolute && !air.includes('/v2/consumer/blobs/') && !air.includes('civitai')
    ? air
    : null;
}

export function toReuseItems(
  dataset: { air: string; caption: string }[],
  workflowId: string
): ReuseItem[] {
  return dataset.map((item, i) => ({
    air: item.air,
    caption: item.caption,
    name: `image ${i + 1}`,
    workflowId,
  }));
}

/** Store the dataset for the new-flow hand-off and navigate there (the Select→Data flow pre-fills it). */
export function handoffReuse(items: ReuseItem[]) {
  sessionStorage.setItem('ts:reuse-dataset', JSON.stringify(items));
  void navigate({ view: 'new' });
}

/** Remix: fetch a run's dataset and start a new training pre-loaded with it (reuse the blob airs — no
 *  re-upload). Throws a user-facing message when the run has no reusable dataset so callers can show it. */
export async function remixFromRun(workflowId: string): Promise<void> {
  const dataset = await backend().getRunDataset(workflowId);
  if (dataset.length === 0) throw new Error("This run's data can't be reused.");
  handoffReuse(toReuseItems(dataset, workflowId));
}
