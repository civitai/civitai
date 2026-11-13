import { isOrchestratorUrl } from '~/server/common/constants';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { blobExtension, downloadBlob, fetchBlob } from '~/utils/file-utils';

type DownloadableOutput = Pick<BlobData, 'url' | 'id' | 'type'>;

/** Extension to name a file by when its id has none and there is no blob to read a type from. */
const DEFAULT_EXTENSION: Partial<Record<BlobData['type'], string>> = { video: 'mp4' };

function openHref(href: string) {
  const a = document.createElement('a');
  a.href = href;
  // An attachment downloads and the tab closes; anything else (an error body) opens beside the
  // generator instead of replacing it.
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Saves an output to the device under its own id. An orchestrator URL is linked to directly with
 * `download=true&filename=…`, which the orchestrator answers with `Content-Disposition:
 * attachment`; the browser streams it to disk, so a long video can't time out a fetch into memory.
 */
export async function downloadOutput(
  output: DownloadableOutput,
  deps = { fetchBlob, downloadBlob, openHref }
) {
  const idExt = output.id.match(/\.([^./\\]+)$/)?.[1];
  const baseName = output.id.replace(/\.[^./\\]+$/, '');

  const ext = idExt ?? DEFAULT_EXTENSION[output.type];
  if (isOrchestratorUrl(output.url) && ext) {
    const href = new URL(output.url);
    // Append to the raw query: searchParams.set would re-encode the signed params (`:` → `%3A`),
    // and the orchestrator checks the signature against them.
    const extra = new URLSearchParams({ download: 'true', filename: `${baseName}.${ext}` });
    href.search = href.search ? `${href.search}&${extra}` : `?${extra}`;
    deps.openHref(href.toString());
    return;
  }

  const blob = await deps.fetchBlob(output.url);
  if (!blob) throw new Error('Failed to fetch file');
  deps.downloadBlob(blob, `${baseName}.${blobExtension(blob, idExt ?? 'bin')}`);
}
