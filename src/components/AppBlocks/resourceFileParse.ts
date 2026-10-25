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

/**
 * The whole request (resolve, fetch, parse) must answer inside the SDK's 120 s
 * GET_RESOURCE_FILE timeout, or the block gives up and retries into `busy`.
 */
export const RESOURCE_FILE_DEADLINE_MS = 110_000;

/**
 * Run `work` against a deadline. At the deadline its signal aborts and the
 * returned promise rejects `parse-failed`, whether or not `work` has stopped, so
 * the caller can reply and free its slot. A later result from `work` is dropped.
 */
export function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(resourceFileError('parse-failed', `no answer within ${ms} ms`));
    }, ms);
  });
  const running = work(controller.signal);
  running.catch(() => undefined);
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer));
}

// ── Request contract ─────────────────────────────────────────────────────────

export interface GetResourceFileRequest {
  requestId: string;
  modelVersionId: number;
  fileId?: number;
}

function positiveInt(raw: unknown): number | null {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Validate a raw GET_RESOURCE_FILE payload from the untrusted iframe. `null` means
 * drop it: no requestId to reply to, or ids that are not positive integers. A
 * present-but-invalid `fileId` drops the request rather than silently falling
 * back to the default file.
 */
export function resolveGetResourceFileRequest(raw: unknown): GetResourceFileRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  const modelVersionId = positiveInt(obj.modelVersionId);
  if (modelVersionId === null) return null;
  if (obj.fileId === undefined || obj.fileId === null) {
    return { requestId: obj.requestId, modelVersionId };
  }
  const fileId = positiveInt(obj.fileId);
  if (fileId === null) return null;
  return { requestId: obj.requestId, modelVersionId, fileId };
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

const TRPC_CODE_TO_ERROR: Record<string, ResourceFileErrorCode> = {
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  UNAUTHORIZED: 'unauthorized',
  TOO_MANY_REQUESTS: 'rate-limited',
  PAYLOAD_TOO_LARGE: 'too-large',
};

/**
 * Map a thrown error to the RESOURCE_FILE_RESULT error. A host-tagged error wins,
 * then a tRPC client error's `data.code`; anything else (network, timeout, a
 * corrupt file) is `parse-failed`.
 */
export function classifyResourceFileError(err: unknown): ResourceFileErrorCode {
  if (err && typeof err === 'object') {
    const tag = (err as { resourceFileError?: unknown }).resourceFileError;
    if ((RESOURCE_FILE_ERROR_CODES as readonly unknown[]).includes(tag)) {
      return tag as ResourceFileErrorCode;
    }
    const code = (err as { data?: { code?: unknown } }).data?.code;
    if (typeof code === 'string' && code in TRPC_CODE_TO_ERROR) return TRPC_CODE_TO_ERROR[code];
  }
  return 'parse-failed';
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
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return 'unknown';
  const values = Object.values(graph as Record<string, unknown>);
  const isApiNode = (v: unknown) =>
    !!v && typeof v === 'object' && 'class_type' in v && 'inputs' in v;
  if (values.length > 0 && values.every(isApiNode)) return 'api';
  if (Array.isArray((graph as { nodes?: unknown }).nodes)) return 'ui';
  return 'unknown';
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

function isJsonEntryPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  if (norm.startsWith('__MACOSX/') || norm.includes('/__MACOSX/')) return false;
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (base.startsWith('.')) return false;
  return base.toLowerCase().endsWith('.json');
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
  const entries: ResourceFileEntry[] = [];
  let truncated = false;
  let skippedForSize = false;
  let totalBytes = 0;

  for (const entry of raw) {
    if (!isJsonEntryPath(entry.path)) continue;
    if (entries.length >= caps.maxEntries) {
      truncated = true;
      break;
    }
    if (
      typeof entry.declaredSize === 'number' &&
      Number.isFinite(entry.declaredSize) &&
      entry.declaredSize > caps.perEntryBytes
    ) {
      truncated = true;
      skippedForSize = true;
      continue;
    }
    const remaining = caps.totalBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      skippedForSize = true;
      break;
    }
    // One byte past the limit is enough to tell "exactly at the cap" from "over it".
    const limit = Math.min(caps.perEntryBytes, remaining) + 1;
    let read: { text: string; bytes: number; hitLimit: boolean };
    try {
      read = await entry.read(limit);
    } catch {
      truncated = true;
      continue;
    }
    totalBytes += read.bytes;
    if (read.hitLimit || read.bytes >= limit) {
      truncated = true;
      skippedForSize = true;
      continue;
    }
    let graph: unknown;
    try {
      graph = JSON.parse(read.text);
    } catch {
      truncated = true;
      continue;
    }
    entries.push({ path: entry.path, format: detectGraphFormat(graph), graph });
  }

  if (entries.length === 0) {
    throw resourceFileError(
      skippedForSize ? 'too-large' : 'parse-failed',
      'no readable JSON entry in the file'
    );
  }
  return { entries, truncated };
}
