// Pure, dependency-light logic for the App Blocks wildcard-pack import bridge
// (W13). Split out of the host shell (PageBlockHost) + the zip shell
// (wildcardPackZip) so the security-critical decisions — the request contract,
// the pre-download cap, the txt/yaml parsers, and (crucially) the zip-bomb
// inflation caps — are unit-testable in the node vitest env with NO jszip /
// js-yaml import (the yaml parser is INJECTED into processWildcardEntries).
// Mirrors the pageBlockHostLogic.ts "pure decision, testable" pattern.
//
// The parse semantics mirror the canonical server-side wildcard parser
// (wildcard-set-provisioning.service.ts: `walkYamlTree` flatten to `parent/child`
// names, CRLF/trim/non-empty txt splitting, first-write-wins on name collision)
// so an imported pack matches what provisioning would produce — PLUS a
// Dynamic-Prompts comment strip and the App-Blocks result/inflation caps.

// ── Caps ─────────────────────────────────────────────────────────────────────

export interface WildcardPackCaps {
  /** Max zip entries walked (a zip with more is truncated). */
  maxEntries: number;
  /** Max uncompressed bytes inflated per entry (the anti-zip-bomb per-file cap). */
  perEntryBytes: number;
  /** Max total uncompressed bytes inflated across the pack (anti-zip-bomb). */
  totalBytes: number;
  /** Max options kept per list (excess truncated + flagged). */
  maxOptionsPerList: number;
  /** Max characters kept per option (excess truncated + flagged). */
  maxCharsPerOption: number;
}

export const WILDCARD_PACK_CAPS: WildcardPackCaps = {
  maxEntries: 2048,
  perEntryBytes: 1024 * 1024, // 1 MB / entry
  totalBytes: 16 * 1024 * 1024, // 16 MB total uncompressed
  maxOptionsPerList: 2000,
  maxCharsPerOption: 400,
};

/** Pre-download size ceiling checked on the server-advertised `sizeBytes` BEFORE
 *  the host fetches anything — so an oversized pack is rejected without a byte
 *  ever hitting the tab. */
export const PRE_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024; // 32 MB

export function exceedsPreDownloadCap(sizeBytes: unknown): boolean {
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > PRE_DOWNLOAD_MAX_BYTES;
}

// ── GET_WILDCARD_PACK request contract ───────────────────────────────────────

export interface GetWildcardPackRequest {
  requestId: string;
  modelVersionId: number;
}

/**
 * Validate + normalize a raw GET_WILDCARD_PACK payload from an untrusted iframe.
 * Returns the sanitized request, or `null` when it must be DROPPED (missing /
 * empty requestId — nothing to correlate a reply to — or a non-positive /
 * non-integer modelVersionId). A string modelVersionId (a block may send it as a
 * string) is coerced.
 */
export function resolveGetWildcardPackRequest(raw: unknown): GetWildcardPackRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;

  const rawId = obj.modelVersionId;
  const id =
    typeof rawId === 'number' ? rawId : typeof rawId === 'string' && rawId.trim() ? Number(rawId) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;

  return { requestId: obj.requestId, modelVersionId: id };
}

// ── Error discriminants ──────────────────────────────────────────────────────

export type WildcardPackErrorCode = 'not-found' | 'forbidden' | 'too-large' | 'parse-failed';

/**
 * Map a thrown error to the WILDCARD_PACK_RESULT error discriminant. A tagged
 * error (`err.wildcardPackError`) wins (host-side too-large / parse-failed);
 * otherwise a tRPC client error's `data.code` maps NOT_FOUND / FORBIDDEN /
 * PAYLOAD_TOO_LARGE; anything else (network, abort/timeout, unzip/parse failure)
 * is `parse-failed`.
 */
export function classifyWildcardPackError(err: unknown): WildcardPackErrorCode {
  if (err && typeof err === 'object') {
    const tag = (err as { wildcardPackError?: unknown }).wildcardPackError;
    if (tag === 'too-large' || tag === 'parse-failed' || tag === 'not-found' || tag === 'forbidden') {
      return tag;
    }
    const code = (err as { data?: { code?: unknown } }).data?.code;
    if (code === 'NOT_FOUND') return 'not-found';
    if (code === 'FORBIDDEN') return 'forbidden';
    if (code === 'PAYLOAD_TOO_LARGE') return 'too-large';
  }
  return 'parse-failed';
}

/** Throw a host-tagged error the classifier maps to `code` (used by the zip/host
 *  shells for too-large / parse-failed states that aren't tRPC errors). */
export function wildcardPackError(code: WildcardPackErrorCode, message?: string): Error {
  const err = new Error(message ?? code) as Error & { wildcardPackError: WildcardPackErrorCode };
  err.wildcardPackError = code;
  return err;
}

// ── Entry classification ─────────────────────────────────────────────────────

export type WildcardEntryKind = 'txt' | 'yaml' | 'skip';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function basename(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function stripListExtension(name: string): string {
  return name.replace(/\.(?:txt|ya?ml)$/i, '');
}

/**
 * Decide how (or whether) to handle a zip entry. `.txt` → one list; `.yaml` /
 * `.yml` → flattened lists; everything ELSE — preview images, nested zips,
 * dotfiles, __MACOSX resource forks — is `skip` and is NEVER inflated (the
 * classifier is consulted BEFORE any read, so a nested zip bomb can't be
 * inflated at all).
 */
export function classifyWildcardEntry(path: string): WildcardEntryKind {
  const norm = normalizePath(path);
  if (norm.startsWith('__MACOSX/') || norm.includes('/__MACOSX/')) return 'skip';
  const base = basename(norm);
  // Dotfiles (`.DS_Store`, `.gitignore`) + macOS `._` resource forks — skip.
  if (base.startsWith('.') || base.startsWith('._')) return 'skip';
  const lower = base.toLowerCase();
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'skip';
}

// ── txt parsing ──────────────────────────────────────────────────────────────

/**
 * A COMMENT line — stripped. `#` followed by whitespace, or a bare `#`. A value
 * like `#ffffff` (a hex color: `#` followed by a NON-space) is NOT a comment and
 * is kept. This is the deliberate fix for #3130's nit (it dropped every `#`-led
 * line, eating hex-color values). Deterministic: `#comment` (no space) is treated
 * as a value, not a comment — the space-or-EOL rule is the discriminator.
 */
export function isTxtCommentLine(line: string): boolean {
  return /^#(?:\s|$)/.test(line);
}

/** Extract raw (un-deduped, un-capped) txt options: CRLF-split, trim, drop blank
 *  + comment lines. Caps are applied later in `finalizeOptions`. */
export function extractTxtOptions(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (isTxtCommentLine(line)) continue;
    out.push(line);
  }
  return out;
}

// ── yaml flattening ──────────────────────────────────────────────────────────

export interface RawList {
  name: string;
  options: string[];
}

/**
 * Flatten a parsed (Dynamic-Prompts) YAML tree into named lists, joining the
 * path from root to each leaf array/scalar with `/` (`clothing/tops`). Mirrors
 * the canonical server `walkYamlTree`: mixed array+map siblings work, scalar
 * leaves become one-element lists, and name collisions are first-write-wins
 * (case-insensitive). Tolerant of a non-object root (returns []).
 */
export function flattenYamlLists(parsed: unknown): RawList[] {
  const out: RawList[] = [];
  const seen = new Set<string>();

  const pushLeaf = (name: string, items: unknown[]) => {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return;
    const options = items
      .map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (options.length === 0) return;
    seen.add(lower);
    out.push({ name, options });
  };

  const walk = (node: unknown, prefix: string) => {
    if (Array.isArray(node)) {
      if (prefix) pushLeaf(prefix, node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (!key) continue;
        walk(child, prefix ? `${prefix}/${key}` : key);
      }
      return;
    }
    if (typeof node === 'string' && node.trim().length > 0 && prefix) {
      pushLeaf(prefix, [node]);
    }
  };

  // Top-level array with no key namespace is handled by the caller (named after
  // the file) — walk with empty prefix so object roots namespace by their keys.
  if (Array.isArray(parsed)) return out; // caller names a bare-array yaml
  walk(parsed, '');
  return out;
}

// ── option finalization (dedupe + caps) ──────────────────────────────────────

/**
 * Apply the RESULT caps to a list's raw options: truncate each option to
 * `maxCharsPerOption`, dedupe (first occurrence wins), cap the count at
 * `maxOptionsPerList`. Sets `truncated` when EITHER an option was char-truncated
 * OR the count cap was hit. Never throws.
 */
export function finalizeOptions(
  rawOptions: string[],
  caps: WildcardPackCaps
): { options: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const options: string[] = [];
  let truncated = false;
  for (const raw of rawOptions) {
    let opt = raw;
    if (opt.length > caps.maxCharsPerOption) {
      opt = opt.slice(0, caps.maxCharsPerOption);
      truncated = true;
    }
    if (seen.has(opt)) continue;
    if (options.length >= caps.maxOptionsPerList) {
      truncated = true;
      break;
    }
    seen.add(opt);
    options.push(opt);
  }
  return { options, truncated };
}

// ── zip-entry orchestration (the anti-zip-bomb core) ─────────────────────────

export interface RawZipEntry {
  path: string;
  /** Declared uncompressed size from the zip central directory, if known. A
   *  cheap belt: an entry whose DECLARED size already blows the per-entry cap is
   *  skipped WITHOUT inflating it. `null`/`undefined` → fall through to the
   *  bounded read (which is the authoritative guard against a lying header). */
  declaredSize?: number | null;
  /**
   * Inflate this entry, HARD-BOUNDED to `limitBytes` — the implementation MUST
   * stop inflating once `limitBytes` bytes have been produced and report
   * `hitLimit: true` (a streamed/paused inflate). This is the guarantee that a
   * hyper-compressible entry can't be fully inflated. `bytes` is the actual
   * inflated byte count (≤ limitBytes + one decompress block).
   */
  read: (limitBytes: number) => Promise<{ text: string; bytes: number; hitLimit: boolean }>;
}

export interface WildcardPackLists {
  lists: Record<string, string[]>;
  truncated: boolean;
  truncatedLists: string[];
}

export interface ProcessWildcardOptions {
  /** Injected YAML parser (e.g. js-yaml `load`) — kept OUT of this pure module so
   *  it stays dependency-light + unit-testable without pulling js-yaml. */
  parseYaml: (text: string) => unknown;
}

/**
 * Walk classified zip entries and build the named lists, enforcing EVERY cap:
 *   - `maxEntries`   — stop after N entries (truncated).
 *   - `perEntryBytes`— declared-size skip belt + a hard-bounded `read` per entry.
 *   - `totalBytes`   — running uncompressed budget; the loop stops when hit, and
 *                      each read is bounded to the SMALLER of the per-entry cap
 *                      and the remaining total budget.
 *   - result caps    — via finalizeOptions (dedupe, option-count, char-length).
 *
 * CRUCIAL (the bug #3130 had): the per-entry cap is enforced DURING inflation by
 * bounding `read`, and oversized/hyper-inflating entries are SKIPPED or BOUNDED —
 * never fully inflated then flagged. A skipped image / nested zip / dotfile is
 * never read at all. A malformed yaml (or an unreadable entry) is TOLERATED
 * (skipped + truncated flag), never thrown. Name collisions are first-write-wins.
 */
export async function processWildcardEntries(
  entries: RawZipEntry[],
  caps: WildcardPackCaps,
  opts: ProcessWildcardOptions
): Promise<WildcardPackLists> {
  const raw = new Map<string, string[]>(); // insertion-ordered; first-write-wins
  const seenNames = new Set<string>();
  let truncated = false;
  let totalBytes = 0;
  let processed = 0;

  const addList = (name: string, options: string[]) => {
    if (options.length === 0) return;
    const lower = name.toLowerCase();
    if (seenNames.has(lower)) return;
    seenNames.add(lower);
    raw.set(name, options);
  };

  for (const entry of entries) {
    if (processed >= caps.maxEntries) {
      truncated = true;
      break;
    }
    const kind = classifyWildcardEntry(entry.path);
    if (kind === 'skip') continue; // images / nested zips / dotfiles: never inflate

    // Declared-size belt — skip WITHOUT inflating when the header already exceeds
    // the per-entry cap.
    if (
      typeof entry.declaredSize === 'number' &&
      Number.isFinite(entry.declaredSize) &&
      entry.declaredSize > caps.perEntryBytes
    ) {
      truncated = true;
      continue;
    }

    if (totalBytes >= caps.totalBytes) {
      truncated = true;
      break; // total uncompressed budget exhausted — stop the loop
    }

    processed++;
    const limit = Math.min(caps.perEntryBytes, caps.totalBytes - totalBytes);

    let read: { text: string; bytes: number; hitLimit: boolean };
    try {
      read = await entry.read(limit);
    } catch {
      truncated = true; // unreadable / corrupt entry — tolerate, keep going
      continue;
    }
    totalBytes += read.bytes;
    if (read.hitLimit) truncated = true;

    if (kind === 'txt') {
      const name = stripListExtension(basename(entry.path));
      if (name) addList(name, extractTxtOptions(read.text));
      continue;
    }

    // yaml / yml
    let parsed: unknown;
    try {
      parsed = opts.parseYaml(read.text);
    } catch {
      truncated = true; // malformed yaml — tolerate (never fail the whole pack)
      continue;
    }
    if (Array.isArray(parsed)) {
      // Bare top-level array → one list named after the file.
      const name = stripListExtension(basename(entry.path));
      const options = parsed
        .map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (name) addList(name, options);
    } else {
      for (const list of flattenYamlLists(parsed)) addList(list.name, list.options);
    }
  }

  const lists: Record<string, string[]> = {};
  const truncatedLists: string[] = [];
  for (const [name, options] of raw) {
    const fin = finalizeOptions(options, caps);
    if (fin.options.length === 0) continue;
    lists[name] = fin.options;
    if (fin.truncated) {
      truncated = true;
      truncatedLists.push(name);
    }
  }

  return { lists, truncated, truncatedLists };
}
