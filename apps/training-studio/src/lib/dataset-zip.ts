import JSZip from 'jszip';
import { extOfMime } from '$lib/media';
import { pool } from '$lib/pool';

/** One dataset file for the zip: `base` names both the media file and its `.txt` caption. `ext` is the
 *  caller's best guess; the blob's MIME is the fallback when it has none. */
export interface DatasetZipItem {
  base: string;
  ext?: string;
  caption: string;
  load: () => Promise<Blob>;
}

/** Filesystem-safe, case-insensitively unique base names (`a`, `a-2`, …) in input order — two files
 *  sharing a base would also share one caption `.txt` in the zip. */
export function uniqueBaseNames(names: string[], fallback = 'image'): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const clean =
      name
        .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 120) || fallback;
    let base = clean;
    for (let n = 2; used.has(base.toLowerCase()); n++) base = `${clean}-${n}`;
    used.add(base.toLowerCase());
    return base;
  });
}

/** A standard LoRA-layout zip: each media file plus a same-named `.txt` caption, which round-trips with
 *  the Data step's "Import .zip" and works in other trainers. Items whose bytes can't be loaded are
 *  skipped and counted; `blob` is null when none loaded, so an empty zip never reads as success. */
export async function buildDatasetZip(
  items: DatasetZipItem[]
): Promise<{ blob: Blob | null; included: number; failed: number }> {
  const zip = new JSZip();
  let included = 0;
  await pool(items, 6, async (item) => {
    let blob: Blob;
    try {
      blob = await item.load();
    } catch {
      return;
    }
    included += 1;
    // The Blob itself in a browser, which can keep it out of the JS heap. JSZip reads Blobs through
    // FileReader, which Node (the tests) lacks, so there it needs the bytes.
    const name = `${item.base}.${item.ext ?? extOfMime(blob.type) ?? 'png'}`;
    zip.file(name, typeof FileReader === 'undefined' ? await blob.arrayBuffer() : blob);
    const caption = item.caption.trim();
    if (caption) zip.file(`${item.base}.txt`, caption);
  });
  const failed = items.length - included;
  if (included === 0) return { blob: null, included, failed };
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
  return { blob, included, failed };
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
