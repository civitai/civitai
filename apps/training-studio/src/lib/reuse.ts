import { backend, navigate } from '$lib/host';
import type { DatasetItem } from '$lib/data/trainingRows';
import { trainingBlobKey } from '$lib/train-core';

export interface ReuseItem {
  air: string;
  caption: string;
  name: string;
  /** The run the blobs belong to — DataStep fetches each preview through it lazily. Reuse used to
   *  download EVERY dataset image up front, which read as an indefinite "Loading…" on any large or
   *  slow dataset; the `air` is what trains, so the hand-off must never wait on previews. */
  workflowId: string;
  /** Set on an edit run's items: its pair layout path (`DatasetItem.path`). */
  path?: string;
  /** A starting image the run also rendered samples from: the URL it sent then, which a new run's
   *  samples and helpers can send again. */
  url?: string;
}

/** Dev-preview stand-ins are plain fetchable URLs; anything blob-backed needs the authenticated
 *  fetch through the seam (`backend().datasetBlob`). */
export function directDatasetUrl(air: string): string | null {
  const isAbsolute = air.startsWith('http://') || air.startsWith('https://');
  return isAbsolute && !air.includes('/v2/consumer/blobs/') && !air.includes('civitai')
    ? air
    : null;
}

/** A blob-backed item's bytes as a local object URL for its preview; '' when they can't be read. */
export function blobPreviewUrl(air: string, workflowId: string): Promise<string> {
  return backend()
    .datasetBlob(air, workflowId)
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => '');
}

export function toReuseItems(
  dataset: DatasetItem[],
  workflowId: string,
  sampleImages: string[] = []
): ReuseItem[] {
  const sampleUrls = new Map(sampleImages.map((url) => [trainingBlobKey(url), url]));
  return dataset.map((item, i) => {
    const url = item.path ? sampleUrls.get(trainingBlobKey(item.air)) : undefined;
    return {
      air: item.air,
      caption: item.caption,
      name: item.path ?? `image ${i + 1}`,
      workflowId,
      ...(item.path ? { path: item.path } : {}),
      ...(url ? { url } : {}),
    };
  });
}

/** An edit run's dataset: pairs placed by path, which only the edit Data step can take. */
export const isPairDataset = (dataset: { path?: string }[]) => dataset.some((i) => !!i.path);

/** Store the dataset for the new-flow hand-off and navigate there (the Select→Data flow pre-fills it). */
export function handoffReuse(items: ReuseItem[]) {
  sessionStorage.setItem('ts:reuse-dataset', JSON.stringify(items));
  void navigate({ view: 'new' });
}

/** Remix: fetch a run's dataset and start a new training pre-loaded with it (reuse the blob airs — no
 *  re-upload). Throws a user-facing message when the run has no reusable dataset so callers can show it. */
export async function remixFromRun(workflowId: string): Promise<void> {
  const { dataset, sourceImages } = await backend().getRunDetail(workflowId);
  if (dataset.length === 0) throw new Error("This run's data can't be reused.");
  handoffReuse(toReuseItems(dataset, workflowId, sourceImages));
}
