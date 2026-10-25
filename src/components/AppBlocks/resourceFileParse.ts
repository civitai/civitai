// Pure logic for the App Blocks GET_RESOURCE_FILE bridge (civitai-app-starters#664):
// the request contract, the error mapping, the caps and the graph-format detector.
// The fetch + unzip shell is `resourceFileHost.ts`, imported lazily by the host.

// ── Caps ─────────────────────────────────────────────────────────────────────

export interface ResourceFileCaps {
  /** JSON entries returned; more sets `truncated`. */
  maxEntries: number;
  /** Bytes inflated per JSON entry; a larger entry is skipped. */
  perEntryBytes: number;
  /** Bytes inflated across the whole file. */
  totalBytes: number;
}

export const RESOURCE_FILE_CAPS: ResourceFileCaps = {
  maxEntries: 20,
  perEntryBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
};

/** Per tab, like WILDCARD_MAX_CONCURRENT; its own counter. */
export const RESOURCE_FILE_MAX_CONCURRENT = 3;

// ── Request contract ─────────────────────────────────────────────────────────

export interface GetResourceFileRequest {
  requestId: string;
  modelVersionId: number;
  fileId?: number;
}


/**
 * Validate a raw GET_RESOURCE_FILE payload from the untrusted iframe. `null` means
 * drop it: no requestId to reply to, or ids that are not positive integers. A
 * present-but-invalid `fileId` drops the request rather than silently falling
 * back to the default file.
 */
export function resolveGetResourceFileRequest(raw: unknown): GetResourceFileRequest | null {
  void raw;
  return null; // STUB (red commit)
}

// ── Error discriminants ──────────────────────────────────────────────────────

// The CLOSED set RESOURCE_FILE_RESULT.error is validated against block-side. A
// code outside it is dropped by the SDK transport and the block's request hangs.
// Mirrors `BlockResourceFileErrorCode` in @civitai/app-sdk; alias it to the SDK
// type once the installed SDK exports it, as wildcardPackParse.ts does.
export const RESOURCE_FILE_ERROR_CODES = [
  'not-found',
  'forbidden',
  'unauthorized',
  'too-large',
  'parse-failed',
  'busy',
  'rate-limited',
] as const;
export type ResourceFileErrorCode = (typeof RESOURCE_FILE_ERROR_CODES)[number];


/**
 * Map a thrown error to the RESOURCE_FILE_RESULT error. A host-tagged error wins,
 * then a tRPC client error's `data.code`; anything else (network, timeout, a
 * corrupt file) is `parse-failed`.
 */
export function classifyResourceFileError(err: unknown): ResourceFileErrorCode {
  void err;
  return 'parse-failed'; // STUB (red commit)
}

export function resourceFileError(code: ResourceFileErrorCode, message?: string): Error {
  const err = new Error(message ?? code) as Error & { resourceFileError: ResourceFileErrorCode };
  err.resourceFileError = code;
  return err;
}

// ── Graph format ─────────────────────────────────────────────────────────────

export type ResourceGraphFormat = 'api' | 'ui' | 'unknown';

/**
 * `api` when every top-level value is a node with `class_type` and `inputs` (the
 * ComfyUI API/prompt format); `ui` when there is a `nodes` array (the editor's
 * saved workflow); otherwise `unknown`.
 */
export function detectGraphFormat(graph: unknown): ResourceGraphFormat {
  void graph;
  return 'unknown'; // STUB (red commit)
}

// ── Entries ──────────────────────────────────────────────────────────────────

export interface ResourceFileEntry {
  path: string;
  format: ResourceGraphFormat;
  graph: unknown;
}

export interface ResourceFileEntries {
  entries: ResourceFileEntry[];
  truncated: boolean;
}

export interface RawResourceEntry {
  path: string;
  /** Uncompressed size from the zip header, when known. Checked before inflating. */
  declaredSize?: number | null;
  /** Inflate at most `limitBytes`; `hitLimit` says the entry was larger. */
  read: (limitBytes: number) => Promise<{ text: string; bytes: number; hitLimit: boolean }>;
}


/**
 * Parse the JSON entries of a file, enforcing every cap. Non-JSON entries are
 * never read. An entry that is too large or is not valid JSON is skipped and sets
 * `truncated`, as does a file with more than `maxEntries` JSON entries.
 *
 * Throws `too-large` when nothing could be returned because of the size caps,
 * and `parse-failed` when the file held no readable JSON entry at all.
 */
export async function processResourceEntries(
  raw: RawResourceEntry[],
  caps: ResourceFileCaps = RESOURCE_FILE_CAPS
): Promise<ResourceFileEntries> {
  void raw;
  void caps;
  throw resourceFileError('parse-failed', 'not implemented'); // STUB (red commit)
}
