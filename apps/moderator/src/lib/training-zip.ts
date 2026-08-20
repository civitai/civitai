import JSZip from 'jszip';

// Mirrors the main app's MIME_TYPES / MEDIA_TYPE tables: entries outside them are dropped, so a caption
// .txt or a stray dotfile never reaches the grid as an unrenderable tile.
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/vnd.wave',
};

const KIND_BY_MIME: Record<string, TrainingAssetKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/vnd.wave': 'audio',
};

export type TrainingAssetKind = 'image' | 'video' | 'audio';
export type TrainingAsset = {
  url: string;
  name: string;
  mimeType: string;
  kind: TrainingAssetKind;
};

/**
 * The two halves of the wait, reported separately because they fail differently and only one of them
 * touches the network: a stall while `unpacking` is the browser decompressing, and looks identical to a
 * dead download if both phases share one message.
 */
export type TrainingProgress =
  | { phase: 'downloading'; receivedBytes: number; totalBytes: number | null }
  | { phase: 'unpacking'; done: number; total: number };

const DOWNLOAD_TIMEOUT_MS = 300_000;

export type LoadTrainingOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: TrainingProgress) => void;
};

/** Fetches and unpacks a version's training zip in the browser. On success the caller owns the object
 *  URLs and must pass them to `revokeTrainingAssets`; on failure or abort this releases its own. */
export async function loadTrainingAssets(
  versionId: number,
  options: LoadTrainingOptions = {}
): Promise<TrainingAsset[]> {
  const { signal, onProgress } = options;
  const assets: TrainingAsset[] = [];

  try {
    const zip = await JSZip.loadAsync(await download(versionId, signal, onProgress));

    const entries = Object.entries(zip.files).filter(([name, entry]) => {
      if (entry.dir || name.startsWith('__MACOSX/') || name.endsWith('.DS_STORE')) return false;
      return !!kindOf(name);
    });

    let done = 0;
    onProgress?.({ phase: 'unpacking', done, total: entries.length });
    for (const [name, entry] of entries) {
      // JSZip cannot be handed an AbortSignal, so cancellation lands between entries rather than
      // during one. Without this a closed sheet keeps decompressing the whole dataset.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const media = kindOf(name)!;
      const blob = await entry.async('blob');
      assets.push({ url: URL.createObjectURL(blob), name, ...media });
      onProgress?.({ phase: 'unpacking', done: ++done, total: entries.length });
    }

    return assets.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    revokeTrainingAssets(assets);
    throw e;
  }
}

function kindOf(name: string): { mimeType: string; kind: TrainingAssetKind } | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = MIME_BY_EXT[ext];
  const kind = mimeType ? KIND_BY_MIME[mimeType] : undefined;
  return mimeType && kind ? { mimeType, kind } : null;
}

/** Streamed rather than `res.blob()` so the download reports bytes as they land — the zip can run to
 *  hundreds of megabytes, and an indeterminate spinner over that is indistinguishable from a hang. */
async function download(
  versionId: number,
  signal: AbortSignal | undefined,
  onProgress: LoadTrainingOptions['onProgress']
): Promise<Blob> {
  // Matches the main app's 300s ceiling. Combined with the caller's signal so closing the viewer still
  // aborts immediately, while a stalled stream cannot hang the panel indefinitely.
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await fetch(`/api/training-data/${versionId}`, { signal: combined });
  if (!res.ok) {
    // The proxy explains its refusal in the body; a bare status is what made this undiagnosable.
    const detail = await res.text().catch(() => '');
    throw new Error(`Could not download the training data (${res.status}). ${detail}`.trim());
  }

  const header = Number(res.headers.get('content-length'));
  const totalBytes = Number.isFinite(header) && header > 0 ? header : null;
  onProgress?.({ phase: 'downloading', receivedBytes: 0, totalBytes });

  const reader = res.body?.getReader();
  if (!reader) return res.blob();
  // Cancelling a already-settled reader rejects; the abort itself is the outcome we want.
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  combined.addEventListener('abort', cancelReader, { once: true });

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;
    onProgress?.({ phase: 'downloading', receivedBytes, totalBytes });
  }
  return new Blob(chunks as BlobPart[]);
}

export function revokeTrainingAssets(assets: TrainingAsset[]): void {
  for (const asset of assets) URL.revokeObjectURL(asset.url);
}
