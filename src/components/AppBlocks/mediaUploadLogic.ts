/**
 * `OPEN_MEDIA_UPLOAD` → `MEDIA_UPLOAD_RESULT`: the pure half of a page block uploading an image,
 * video or audio file as a PRIVATE generation input (an orchestrator consumer blob), either picked
 * by the viewer in host chrome or supplied as bytes the block made in the tab.
 *
 * The SDK's mock host (`@civitai/blocks-react`, `mediaUploadBytes.ts`) copies these limits, sniff
 * rules and error strings so a block test accepts and refuses what production does; change both.
 */

import { maxOrchestratorImageFileSize } from '~/server/common/constants';
import { ENGINE_INPUT_IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { CONSUMER_BLOB_MAX_UPLOAD_BYTES } from '~/utils/consumer-blob-upload';
import {
  admitSaveBytes,
  saveBytesWindowHasRoom,
  sniffSaveBytesImage,
  type BytesWindowLimits,
  type SaveBytesWindowEntry,
} from './saveImageDownload';

export const MEDIA_UPLOAD_KINDS = ['image', 'video', 'audio'] as const;
export type MediaUploadKind = (typeof MEDIA_UPLOAD_KINDS)[number];

export const MEDIA_UPLOAD_MAX_BYTES = CONSUMER_BLOB_MAX_UPLOAD_BYTES;
/**
 * An image is decoded in full before it is resized, so it keeps the source-image modal's lower cap
 * rather than the upload's.
 */
export const MEDIA_UPLOAD_MAX_BYTES_BY_KIND: Record<MediaUploadKind, number> = {
  image: maxOrchestratorImageFileSize,
  video: MEDIA_UPLOAD_MAX_BYTES,
  audio: MEDIA_UPLOAD_MAX_BYTES,
};

/** Bytes mode only: a picked file is gated on a person. Each upload stores a blob for the viewer. */
export const MEDIA_UPLOAD_WINDOW_LIMITS: BytesWindowLimits = {
  windowMs: 60_000,
  maxPerWindow: 8,
  maxBytesPerWindow: 2 * MEDIA_UPLOAD_MAX_BYTES,
};

export const MEDIA_UPLOAD_INVALID_ERROR = 'invalid media-upload request';
export const MEDIA_UPLOAD_KIND_ERROR = "kind must be 'image', 'video' or 'audio'";
export const MEDIA_UPLOAD_PURPOSE_ERROR = "purpose must be 'generationSource'";
export const MEDIA_UPLOAD_TOO_LARGE_ERROR: Record<MediaUploadKind, string> = {
  image: 'file exceeds the 24 MB image upload limit',
  video: 'file exceeds the 64 MB upload limit',
  audio: 'file exceeds the 64 MB upload limit',
};
export const MEDIA_UPLOAD_MIME_MISMATCH_ERROR = "mimeType does not match the file's content";
export const MEDIA_UPLOAD_BUSY_ERROR = 'busy';
export const MEDIA_UPLOAD_NO_TOKEN_ERROR = 'no block token';
export const MEDIA_UPLOAD_FAILED_ERROR = 'media upload failed — please try again';
export const MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR = 'this file has no video track';
export const MEDIA_UPLOAD_TYPE_ERROR: Record<MediaUploadKind, string> = {
  image: 'images must be PNG, JPEG or WebP',
  video: 'videos must be MP4 or WebM',
  audio: 'audio must be MP3, WAV or WebM',
};
export const MEDIA_UPLOAD_UNREADABLE_ERROR: Record<'video' | 'audio', string> = {
  video: 'could not read this video file',
  audio: 'could not read this audio file',
};

/**
 * What the file input offers per kind. Content is still checked by `sniffMediaType`, which has no
 * AVIF rule, so images stop at the engine-input set rather than the source-image modal's wider one.
 */
export const MEDIA_UPLOAD_ACCEPT: Record<MediaUploadKind, string> = {
  image: ENGINE_INPUT_IMAGE_MIME_TYPE.join(','),
  video: VIDEO_MIME_TYPE.join(','),
  audio: 'audio/mpeg,audio/wav,audio/x-wav,audio/webm',
};

export type BlockMediaUploadInfo = {
  url: string;
  kind: MediaUploadKind;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type MediaUploadRequest = {
  requestId: string;
  kind: MediaUploadKind;
  bytes?: ArrayBuffer;
  mimeType?: string;
};

export type MediaUploadDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: string }
  | { kind: 'ok'; request: MediaUploadRequest };

/**
 * Parse a raw `OPEN_MEDIA_UPLOAD` payload. `drop` = no usable requestId, so no reply can be
 * correlated. A typed-array view is refused, not unwrapped: its window into `.buffer` is not the
 * file.
 */
export function resolveMediaUploadRequest(raw: unknown): MediaUploadDecision {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) return { kind: 'drop' };
  const requestId = r.requestId;
  if (!(MEDIA_UPLOAD_KINDS as readonly unknown[]).includes(r.kind)) {
    return { kind: 'refuse', requestId, error: MEDIA_UPLOAD_KIND_ERROR };
  }
  if (r.purpose !== 'generationSource') {
    return { kind: 'refuse', requestId, error: MEDIA_UPLOAD_PURPOSE_ERROR };
  }
  const kind = r.kind as MediaUploadKind;
  if (r.bytes == null) return { kind: 'ok', request: { requestId, kind } };
  if (!(r.bytes instanceof ArrayBuffer) || r.bytes.byteLength === 0) {
    return { kind: 'refuse', requestId, error: MEDIA_UPLOAD_INVALID_ERROR };
  }
  if (r.mimeType !== undefined && typeof r.mimeType !== 'string') {
    return { kind: 'refuse', requestId, error: MEDIA_UPLOAD_INVALID_ERROR };
  }
  return {
    kind: 'ok',
    request: { requestId, kind, bytes: r.bytes, mimeType: r.mimeType as string | undefined },
  };
}

function ascii(u8: Uint8Array, offset: number, text: string): boolean {
  if (u8.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (u8[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function containsAscii(u8: Uint8Array, end: number, text: string): boolean {
  for (let i = 0; i + text.length <= Math.min(end, u8.length); i++) {
    if (ascii(u8, i, text)) return true;
  }
  return false;
}

function isWebm(u8: Uint8Array): boolean {
  return (
    u8.length >= 4 &&
    u8[0] === 0x1a &&
    u8[1] === 0x45 &&
    u8[2] === 0xdf &&
    u8[3] === 0xa3 &&
    containsAscii(u8, 64, 'webm')
  );
}

function isMp3(u8: Uint8Array): boolean {
  if (ascii(u8, 0, 'ID3')) return true;
  if (u8.length < 2 || u8[0] !== 0xff || (u8[1] & 0xe0) !== 0xe0) return false;
  const layer = (u8[1] >> 1) & 0x03;
  const version = (u8[1] >> 3) & 0x03;
  return layer !== 0 && version !== 1;
}

/**
 * The content type `bytes` holds, judged by magic bytes only and only among the types `kind`
 * allows; `null` otherwise. WebM carries no audio/video marker in its header, so `kind` decides.
 */
export function sniffMediaType(kind: MediaUploadKind, bytes: ArrayBuffer): string | null {
  const u8 = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64));
  if (kind === 'image') return sniffSaveBytesImage(u8);
  if (kind === 'video') {
    if (ascii(u8, 4, 'ftyp') && u8.length >= 12) return 'video/mp4';
    return isWebm(u8) ? 'video/webm' : null;
  }
  if (ascii(u8, 0, 'RIFF') && ascii(u8, 8, 'WAVE')) return 'audio/wav';
  if (isWebm(u8)) return 'audio/webm';
  return isMp3(u8) ? 'audio/mpeg' : null;
}

function normaliseMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return base === 'audio/x-wav' ? 'audio/wav' : base;
}

/**
 * The per-file checks a picked file and a bytes upload share: the size cap, then the content.
 * `head` needs only the file's first 64 bytes.
 */
export function checkMediaFile(
  kind: MediaUploadKind,
  size: number,
  head: ArrayBuffer
): { ok: true; contentType: string } | { ok: false; error: string } {
  if (size > MEDIA_UPLOAD_MAX_BYTES_BY_KIND[kind]) {
    return { ok: false, error: MEDIA_UPLOAD_TOO_LARGE_ERROR[kind] };
  }
  const contentType = sniffMediaType(kind, head);
  if (!contentType) return { ok: false, error: MEDIA_UPLOAD_TYPE_ERROR[kind] };
  return { ok: true, contentType };
}

/**
 * The bytes-mode admission decision, in the order that keeps each refusal accurate:
 *   1. the size cap FIRST, so an over-cap file is always too large, never `busy`;
 *   2. the window, non-recording, so a full window refuses before any sniffing;
 *   3. the content, then a declared `mimeType` against it;
 *   4. record the upload. Only an upload that will run counts.
 */
export function processMediaUploadBytes(
  req: { kind: MediaUploadKind; bytes: ArrayBuffer; mimeType?: string },
  recent: readonly SaveBytesWindowEntry[],
  now: number
): {
  result: { ok: true; contentType: string } | { ok: false; error: string };
  recent: SaveBytesWindowEntry[];
} {
  const size = req.bytes.byteLength;
  const refuse = (error: string) => ({
    result: { ok: false as const, error },
    recent: [...recent],
  });
  if (size > MEDIA_UPLOAD_MAX_BYTES_BY_KIND[req.kind])
    return refuse(MEDIA_UPLOAD_TOO_LARGE_ERROR[req.kind]);
  if (!saveBytesWindowHasRoom(recent, now, size, MEDIA_UPLOAD_WINDOW_LIMITS)) {
    return refuse(MEDIA_UPLOAD_BUSY_ERROR);
  }
  const checked = checkMediaFile(req.kind, size, req.bytes);
  if (!checked.ok) return refuse(checked.error);
  if (req.mimeType !== undefined && normaliseMimeType(req.mimeType) !== checked.contentType) {
    return refuse(MEDIA_UPLOAD_MIME_MISMATCH_ERROR);
  }
  const admitted = admitSaveBytes(recent, now, size, MEDIA_UPLOAD_WINDOW_LIMITS);
  if (!admitted.ok) {
    return { result: { ok: false, error: MEDIA_UPLOAD_BUSY_ERROR }, recent: admitted.recent };
  }
  return { result: { ok: true, contentType: checked.contentType }, recent: admitted.recent };
}
