import { backend, navigate } from '$lib/host';

export interface ReuseItem {
  air: string;
  caption: string;
  name: string;
  previewUrl: string;
}

/** Dev-preview stand-ins are plain fetchable URLs; anything blob-backed needs the authenticated
 *  fetch through the seam (`backend().datasetBlob`). */
export function directDatasetUrl(air: string): string | null {
  const isAbsolute = air.startsWith('http://') || air.startsWith('https://');
  return isAbsolute && !air.includes('/v2/consumer/blobs/') && !air.includes('civitai')
    ? air
    : null;
}

/** Map a fetched run dataset to reuse items for a given source run. Blob-backed previews become
 *  object URLs whose ownership passes to the flow (it revokes them on unmount); a preview that
 *  can't be fetched degrades to an empty tile — the `air` is what trains, not the preview. */
export async function toReuseItems(
  dataset: { air: string; caption: string }[],
  workflowId: string
): Promise<ReuseItem[]> {
  return Promise.all(
    dataset.map(async (item, i) => ({
      air: item.air,
      caption: item.caption,
      name: `image ${i + 1}`,
      previewUrl:
        directDatasetUrl(item.air) ??
        (await backend()
          .datasetBlob(item.air, workflowId)
          .then((blob) => URL.createObjectURL(blob))
          .catch(() => '')),
    }))
  );
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
  handoffReuse(await toReuseItems(dataset, workflowId));
}
