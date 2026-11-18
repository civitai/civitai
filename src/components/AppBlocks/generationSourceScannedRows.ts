/**
 * App Blocks: what a generation source the viewer uploaded is handed back as.
 *
 * The host uploads a picked source (`OPEN_IMAGE_UPLOAD { purpose: 'generationSource' }`, a single
 * `OPEN_MEDIA_UPLOAD` image) as a consumer blob, exactly as it always has. While the
 * `app-block-source-scanned-rows` flag is on, the generation gate refuses every orchestrator url
 * an app sends, so that blob would be unusable: the host then has the server copy it into a
 * PRIVATE, scanned `Image` row (`blocks.persistUploadedGenerationSource`) and hands the app that
 * row's url instead, with `imageId` and `ready` as `PERSIST_GENERATION_SOURCE` returns them.
 *
 * The one rule for which answer the app gets lives here, shared by both upload paths.
 */

/** A source as uploaded: the consumer blob's url and the size read back from it. */
export type UploadedSourceBlob = { url: string; width: number; height: number };

/** `blocks.persistUploadedGenerationSource`'s answer: a private scanned row in the source shape. */
export type ScannedGenerationSource = {
  url: string;
  width: number;
  height: number;
  imageId: number;
  /** The gate accepts `url` now. `false`: the scan had not finished; a submit is refused pending. */
  ready: boolean;
};

/** How the host reaches the server for the scanned path. */
export type ScannedRowsPath = {
  /** Whether the flag selects scanned rows (`blockImageUpload.generationSourceUsesScannedRows`). */
  usesScannedRows: () => Promise<boolean>;
  /** `blocks.persistUploadedGenerationSource` for this blob url, with the current block token. */
  persist: (url: string) => Promise<ScannedGenerationSource>;
};

/**
 * The source to hand the app for an uploaded blob:
 * - no `path` (no block token to call with), the flag OFF, or the flag unreadable (the query
 *   failed): the blob, unchanged. The gate stays the only authority: a blob handed back while
 *   the flag is ON is refused at submit, as it was before scanned rows existed, never admitted;
 * - the flag ON: the server's scanned copy, with the caller's other fields kept. A failed copy
 *   THROWS: the blob is exactly what the gate refuses while the flag is on.
 *
 * `isCurrent`: whether the caller still wants this pick. Read after the path query, so a pick the
 * viewer abandoned meanwhile (re-picked, closed) resolves `null` without asking for a copy, and
 * holds none of the copy's in-flight slots.
 */
export async function toGenerationSource<T extends UploadedSourceBlob>(
  blob: T,
  path: ScannedRowsPath | null | undefined,
  isCurrent: () => boolean = () => true
): Promise<T | (T & ScannedGenerationSource) | null> {
  if (!path) return blob;
  let scannedRows: boolean;
  try {
    scannedRows = (await path.usesScannedRows()) === true;
  } catch {
    scannedRows = false;
  }
  if (!scannedRows) return blob;
  if (!isCurrent()) return null;
  const persisted = await path.persist(blob.url);
  return {
    ...blob,
    url: persisted.url,
    width: persisted.width,
    height: persisted.height,
    imageId: persisted.imageId,
    ready: persisted.ready,
  };
}
