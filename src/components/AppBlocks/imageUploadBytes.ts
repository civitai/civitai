/**
 * `OPEN_IMAGE_UPLOAD { bytes }` — the PURE core of a page block uploading an image it PRODUCED in
 * the viewer's tab (no picker). The host feeds the bytes into the same store upload → persist →
 * scan → gate pipeline a picked `display` upload uses; the only server-visible difference is the
 * `blockUploadedAppId` provenance stamp, which makes the image postable by this app as a
 * `{ kind: 'published' }` post source.
 *
 * Mirrors the `SAVE_IMAGE { bytes }` patterns in `saveImageDownload.ts`: an `ArrayBuffer`-only
 * resolver, a content-sniffed type (never the caller's), and a per-host rolling-window limit
 * applied cap-first.
 */

import { BLOCK_IMAGE_MAX_BYTES } from '~/shared/constants/block-image-upload.constants';
import type { BlockImageScanResult } from './blockImageScanLogic';
import {
  admitSaveBytes,
  forceSaveBytesExtension,
  sanitizeSaveBytesFilename,
  saveBytesWindowHasRoom,
  sniffSaveBytesImage,
  type BytesWindowLimits,
  type SaveBytesWindowEntry,
} from './saveImageDownload';

/** The server's own cap on this pipeline, so the host never uploads a file persist would refuse. */
export const UPLOAD_BYTES_MAX_BYTES = BLOCK_IMAGE_MAX_BYTES;
/** Each upload creates a real, scanned Image row, so the window is far longer than a save's. */
export const UPLOAD_BYTES_WINDOW_MS = 60_000;
/** An app posts what it just made: one image, or a fixed one and a retry, per minute is the use. */
export const UPLOAD_BYTES_MAX_PER_WINDOW = 3;
/** Two max-size files per window, so a burst cannot hold more than that in the viewer's tab. */
export const UPLOAD_BYTES_MAX_BYTES_PER_WINDOW = 2 * UPLOAD_BYTES_MAX_BYTES;

export const UPLOAD_BYTES_WINDOW_LIMITS: BytesWindowLimits = {
  windowMs: UPLOAD_BYTES_WINDOW_MS,
  maxPerWindow: UPLOAD_BYTES_MAX_PER_WINDOW,
  maxBytesPerWindow: UPLOAD_BYTES_MAX_BYTES_PER_WINDOW,
};

export const UPLOAD_BYTES_INVALID_ERROR = 'invalid image-upload request';
export const UPLOAD_BYTES_TOO_LARGE_ERROR = 'file exceeds the maximum upload size';
export const UPLOAD_BYTES_TYPE_NOT_ALLOWED_ERROR = 'file type is not allowed';
export const UPLOAD_BYTES_BUSY_ERROR = 'busy';
export const UPLOAD_BYTES_NO_TOKEN_ERROR = 'no block token';

/** `Image.name`'s bound in the persist input. */
const UPLOAD_BYTES_MAX_FILENAME_LENGTH = 255;

export type UploadBytesImageType = 'image/png' | 'image/webp' | 'image/jpeg';

export type ImageUploadBytesRequest =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'bytes'; bytes: ArrayBuffer; filename?: string };

/**
 * Pick the `bytes` variant out of a raw OPEN_IMAGE_UPLOAD payload. `none` = no `bytes` field, so
 * the picker paths run unchanged. A typed-array view is refused rather than unwrapped (its window
 * into `.buffer` is not the file), as is an empty buffer and `purpose: 'generationSource'` (that
 * purpose never creates an Image row, so there is nothing to stamp).
 */
export function resolveImageUploadBytes(raw: unknown): ImageUploadBytesRequest {
  if (!raw || typeof raw !== 'object') return { kind: 'none' };
  const r = raw as { bytes?: unknown; purpose?: unknown; filename?: unknown };
  if (r.bytes == null) return { kind: 'none' };
  if (!(r.bytes instanceof ArrayBuffer) || r.bytes.byteLength === 0) return { kind: 'invalid' };
  if (r.purpose === 'generationSource') return { kind: 'invalid' };
  return {
    kind: 'bytes',
    bytes: r.bytes,
    filename: typeof r.filename === 'string' ? r.filename : undefined,
  };
}

function uploadBytesFilename(raw: string | undefined, type: UploadBytesImageType): string {
  const name = forceSaveBytesExtension(sanitizeSaveBytesFilename(raw), type);
  if (name.length <= UPLOAD_BYTES_MAX_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const ext = name.slice(dot);
  return name.slice(0, UPLOAD_BYTES_MAX_FILENAME_LENGTH - ext.length) + ext;
}

/**
 * The whole host-side admission decision, in the order that keeps a refusal cheap and its error
 * accurate (the `processSaveBytes` order):
 *   1. the per-file cap on `byteLength` — FIRST, so an over-cap file is always too-large, never
 *      `busy` (a retry could never succeed);
 *   2. the window pre-check, non-recording — a full window refuses `busy` before any sniffing;
 *   3. sniff PNG / WebP / JPEG by magic bytes (the shared sniffer, via `sniffSaveBytesImage`);
 *   4. record it in the window — only an upload that will run counts.
 */
export function processUploadBytes(
  req: { bytes: ArrayBuffer; filename?: string },
  recent: readonly SaveBytesWindowEntry[],
  now: number
): {
  result:
    | { ok: true; contentType: UploadBytesImageType; filename: string }
    | { ok: false; error: string };
  recent: SaveBytesWindowEntry[];
} {
  const size = req.bytes.byteLength;
  if (size > UPLOAD_BYTES_MAX_BYTES) {
    return { result: { ok: false, error: UPLOAD_BYTES_TOO_LARGE_ERROR }, recent: [...recent] };
  }
  if (!saveBytesWindowHasRoom(recent, now, size, UPLOAD_BYTES_WINDOW_LIMITS)) {
    return { result: { ok: false, error: UPLOAD_BYTES_BUSY_ERROR }, recent: [...recent] };
  }
  const type = sniffSaveBytesImage(new Uint8Array(req.bytes));
  if (type !== 'image/png' && type !== 'image/webp' && type !== 'image/jpeg') {
    return {
      result: { ok: false, error: UPLOAD_BYTES_TYPE_NOT_ALLOWED_ERROR },
      recent: [...recent],
    };
  }
  const admitted = admitSaveBytes(recent, now, size, UPLOAD_BYTES_WINDOW_LIMITS);
  if (!admitted.ok) {
    return { result: { ok: false, error: UPLOAD_BYTES_BUSY_ERROR }, recent: admitted.recent };
  }
  return {
    result: { ok: true, contentType: type, filename: uploadBytesFilename(req.filename, type) },
    recent: admitted.recent,
  };
}

/**
 * The blocking `IMAGE_UPLOAD_RESULT` for a bytes upload once its scan settles: the moderated
 * projection a picked `display` upload returns, or an `error` string. Never the bare cancelled
 * shape — nothing here was cancelled, and an older SDK reading `error` as absent still sees
 * "no image", which is the safe reading.
 */
export function imageUploadResultFromScan(
  requestId: string,
  result: BlockImageScanResult
):
  | { requestId: string; selected: Extract<BlockImageScanResult, { status: 'scanned' }>['image'] }
  | { requestId: string; error: string } {
  if (result.status === 'scanned') return { requestId, selected: result.image };
  if (result.status === 'blocked') {
    return { requestId, error: result.reason ?? 'that image could not be used' };
  }
  return { requestId, error: result.message ?? 'image scan failed — please try again' };
}
