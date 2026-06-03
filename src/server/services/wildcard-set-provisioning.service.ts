import { Prisma } from '@prisma/client';
import JSZip from 'jszip';
import yaml from 'js-yaml';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { submitWildcardSetAudit } from '~/server/services/wildcard-category-audit.service';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { WILDCARD_CATEGORY_NAME } from '~/utils/prompt-helpers';

// `Wildcards` is the model-type enum value used elsewhere (see ModelType in
// prisma/schema.full.prisma and TrainedWords.tsx). We intentionally hold it
// as a string literal rather than importing the enum to keep the service
// dependency-free at the value layer — the audit job and admin endpoint
// both share this constant.
const WILDCARD_MODEL_TYPE = 'Wildcards' as const;

// Matches Dynamic Prompts nested references including path-like names so a
// ref such as `__uds_wildcards/personmaker/adultage__` (used by packs that
// ship a top-level folder as a namespace) gets normalized to its `#…` form at
// import. Whitespace, `:`, and other separators stay literal — we only claim the
// conservative path-like subset that matches our category-name storage convention.
// The name charset is shared (WILDCARD_CATEGORY_NAME) so it can't drift from the
// prompt `#ref` parser or the save-schema validator.
const NESTED_REFERENCE_PATTERN = new RegExp(`__(${WILDCARD_CATEGORY_NAME})__`, 'g');

const RECONCILE_BATCH_SIZE = 100;

// Defensive size limits. The goal is to reject pathological uploads (zip
// bombs, mislabeled archives containing GBs of binary, dataset-as-wildcard
// abuse) without invalidating legitimate creator content.
//
// Calibration (drawn from a survey of all 1,863 published Wildcards-type
// model versions on the platform):
//   - p95 compressed ≈ 2.3 MB; p99 ≈ 24.5 MB; max 808 MB (DanbooruTags-class
//     dataset abuse). Plain text in a wildcard pack typically compresses
//     ~10× — a 1 MB compressed zip routinely decodes to ~10 MB.
//   - 50 MB zip-total uncompressed covers ~p99 packs with margin while still
//     rejecting dataset-scale abuses. Only ingestible entries (right
//     extension, under per-entry cap, not __MACOSX/etc) count toward this
//     total — bytes we'd skip don't get held against the pack.
//   - 1 MB per .txt is the curated-wildcard ceiling: at ~50 chars/line that's
//     ~20,000 values, well past "pick from a pool" territory. A single .txt
//     past 1 MB is almost always a dataset misuploaded as a wildcard.
//   - 5 MB per .yaml because yamls hold many categories per file (one yaml
//     can equate to a whole zip's worth of .txts).
//   - 4,000 chars per line: a wildcard "value" longer than a paragraph is
//     almost certainly a malformed file; drop the line, keep going.
//   - 5,000 categories per set: defense against a malformed yaml producing
//     pathological structure (every line decoded as its own leaf).
const MAX_TXT_FILE_BYTES = 1 * 1024 * 1024;
const MAX_YAML_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_LINE_CHARS = 4_000;
const MAX_CATEGORIES_PER_SET = 5_000;

// Centralized list of primary-file extensions the parser knows how to handle.
// Anything outside this list takes the `unsupported_format` path — the model
// version is *not* marked invalidated, so when we add support for a new
// format the cron will pick it up on the next run.
const SUPPORTED_EXTENSIONS = ['.zip', '.txt', '.yaml', '.yml'] as const;

function getSupportedExtension(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

export type WildcardCategoryFile = { name: string; lines: string[] };

// Why a zip entry was rejected during the walk. Kept narrow so a creator can
// look at the skip log and immediately know what to fix; macOS/dotfile/
// metadata-name skips are *intentionally* omitted because they're noise the
// creator didn't author.
export type SkippedEntry = {
  path: string;
  reason: 'oversized' | 'binary_signature' | 'invalid_utf8';
  // Bytes of the entry's announced or decoded size. Present when the skip
  // is size-driven; omitted for sniff/encoding rejections where the value
  // doesn't tell the creator anything actionable.
  sizeBytes?: number;
};

// Shape of the open-ended `WildcardSet.metadata` JSON column. Add new fields
// as the feature grows; readers should always treat unknown fields as
// optional. Stays out of first-class columns so we can iterate without
// migrations for set-scoped diagnostic/operational data.
export type WildcardSetMetadata = {
  skippedEntries?: SkippedEntry[];
};

export type ParsedWildcardCategories = {
  categories: WildcardCategoryFile[];
  skipped: SkippedEntry[];
};

export type ImportWildcardModelVersionResult =
  | {
      status: 'created';
      wildcardSetId: number;
      categoryCount: number;
      valueCount: number;
      skippedEntries: SkippedEntry[];
    }
  | { status: 'invalidated'; wildcardSetId: number; reason: string }
  | { status: 'unsupported_format'; fileNames: string[] }
  | { status: 'already_exists'; wildcardSetId: number }
  | { status: 'failed'; error: string };

/**
 * Rewrite Dynamic Prompts nested references (`__name__`) into our canonical
 * `#name` form so storage and the resolver only deal with one syntax.
 * Path-like refs are preserved (`__uds_wildcards/personmaker/easyman__` →
 * `#uds_wildcards/personmaker/easyman`) so packs that nest categories in
 * folders keep their internal references intact. The source-file form is
 * preserved literally if it doesn't match the pattern (e.g. `__weird name__`
 * with a space stays as-is).
 */
export function normalizeNestedRefs(line: string): string {
  return line.replace(NESTED_REFERENCE_PATTERN, '#$1');
}

/**
 * Fetch the primary file's bytes. Any failure here — DNS, TCP, 5xx, mid-stream
 * disconnect — is transport-layer and treated by the caller as transient
 * (retry on the next reconcile pass). Kept separate from parsing so we don't
 * conflate "S3 hiccup" with "this zip is structurally broken."
 */
async function downloadPrimaryFileBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

/**
 * Parse a downloaded primary file's bytes into one `WildcardCategoryFile` per
 * leaf. Supports the layouts the resource picker accepts for `Wildcards`-type
 * models:
 *
 *   - A single `.zip` containing any mix of `.txt` and `.yaml`/`.yml` entries
 *     (folder structure preserved as namespace; yaml internal trees preserved
 *     as namespace)
 *   - A single bare `.txt` (one category named after the file)
 *   - A single bare `.yaml`/`.yml` (categories from the yaml's tree; the
 *     file name is only used if the yaml's root is itself an array)
 *
 * Any throw from this function is structural (corrupt zip, malformed yaml,
 * unsupported extension) and treated by the caller as a persistent failure
 * that warrants marking the version invalidated.
 *
 * Empty/whitespace-only lines are dropped per category. Categories with no
 * non-empty lines are skipped entirely (the caller is expected to skip them
 * too rather than create an empty `WildcardSetCategory`).
 */
export async function parseWildcardCategoriesFromBuffer(
  buffer: ArrayBuffer,
  fileName: string
): Promise<ParsedWildcardCategories> {
  const lowerName = fileName.toLowerCase();
  const skipped: SkippedEntry[] = [];

  if (lowerName.endsWith('.txt')) {
    if (buffer.byteLength > MAX_TXT_FILE_BYTES) {
      throw new Error(
        `txt file too large: ${buffer.byteLength} bytes exceeds limit ${MAX_TXT_FILE_BYTES}`
      );
    }
    const text = decodeUtf8(new Uint8Array(buffer));
    const lines = splitNonEmptyLines(text);
    if (lines.length === 0) return { categories: [], skipped };
    return { categories: [{ name: stripTxtExtension(fileName), lines }], skipped };
  }

  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) {
    if (buffer.byteLength > MAX_YAML_FILE_BYTES) {
      throw new Error(
        `yaml file too large: ${buffer.byteLength} bytes exceeds limit ${MAX_YAML_FILE_BYTES}`
      );
    }
    const text = decodeUtf8(new Uint8Array(buffer));
    return { categories: parseYamlCategories(text, fileName), skipped };
  }

  if (!lowerName.endsWith('.zip')) {
    throw new Error(`unsupported wildcard primary file extension: ${fileName}`);
  }

  const zip = await JSZip.loadAsync(buffer);

  // Zip-bomb defense: sum the announced uncompressed sizes of entries we'd
  // *actually* ingest — bytes we'd skip per-entry (oversized entries,
  // wrong-extension files, __MACOSX) don't get held against the pack. This
  // means a creator with one outlier 5 MB .txt buried in an otherwise-tiny
  // zip won't lose the rest of their pack just because that one file pushed
  // the announced total over the cap. Extension-less entries are counted
  // optimistically since we'd need their bytes to filter further; the
  // per-entry check during the walk still gates them.
  const totalIngestible = Object.values(zip.files).reduce((sum, e) => {
    if (e.dir) return sum;
    const path = normalizeZipEntryPath(e.name);
    if (!path || isMacOsResourceForkEntry(path)) return sum;
    const lower = path.toLowerCase();
    const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml');
    const isTxt = lower.endsWith('.txt');
    const isExtensionless = !isYaml && !isTxt && !hasFileExtension(getBasename(path));
    if (!isYaml && !isTxt && !isExtensionless) return sum;
    const size = getEntryUncompressedSize(e) ?? 0;
    const limit = isYaml ? MAX_YAML_FILE_BYTES : MAX_TXT_FILE_BYTES;
    if (size > limit) return sum; // would be skipped per-entry below
    return sum + size;
  }, 0);
  if (totalIngestible > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new Error(
      `zip total uncompressed size too large: ${totalIngestible} ingestible bytes exceeds limit ${MAX_ZIP_UNCOMPRESSED_BYTES}`
    );
  }

  const out: WildcardCategoryFile[] = [];
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;

    const entryPath = normalizeZipEntryPath(entry.name);
    if (!entryPath) continue;

    // macOS zips smuggle in resource-fork metadata: a `__MACOSX/` sibling tree
    // mirroring every file as `._<name>` (binary AppleDouble — looks like
    // text by extension but isn't). Skip both forms so we don't ingest
    // garbage as wildcard categories.
    if (isMacOsResourceForkEntry(entryPath)) continue;

    const lowerPath = entryPath.toLowerCase();
    const baseName = getBasename(entryPath);
    const isYaml = lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml');
    const isTxt = lowerPath.endsWith('.txt');
    const isExtensionless = !isYaml && !isTxt && !hasFileExtension(baseName);

    // Skip files with extensions we don't recognize. Extension-less files
    // are tentatively allowed and validated below via byte-level sniffing.
    if (!isYaml && !isTxt && !isExtensionless) continue;

    // Per-entry size cap: skip oversized files but keep processing the rest
    // of the zip. One bloated entry shouldn't kill imports of well-formed
    // siblings — the creator can clean up the offending file and re-publish.
    // Track skips so the caller can surface them (creators wonder why a
    // category they uploaded didn't show up).
    const announcedSize = getEntryUncompressedSize(entry);
    const perEntryLimit = isYaml ? MAX_YAML_FILE_BYTES : MAX_TXT_FILE_BYTES;
    if (announcedSize !== null && announcedSize > perEntryLimit) {
      skipped.push({ path: entryPath, reason: 'oversized', sizeBytes: announcedSize });
      continue;
    }

    // Read raw bytes once. Doing so before the binary-sniff and UTF-8
    // checks (which need bytes, not a pre-decoded string) avoids decoding
    // garbage twice.
    const bytes = await entry.async('uint8array');
    if (bytes.length > perEntryLimit) {
      skipped.push({ path: entryPath, reason: 'oversized', sizeBytes: bytes.length });
      continue;
    }

    if (isExtensionless) {
      // Defensive stack: hidden-file skip → metadata-name skip → binary
      // signature skip → UTF-8 validity. Anything past these can be safely
      // treated as a text wildcard file. Hidden/metadata skips are silent
      // (they're noise the creator didn't author); binary/utf-8 skips are
      // tracked because a creator who put an actual file there will want
      // to know why it didn't import.
      if (baseName.startsWith('.')) continue;
      const cleanName = baseName.toLowerCase().replace(/\.+$/, '');
      if (KNOWN_METADATA_NAMES.has(cleanName)) continue;
      const stripped = stripUtf8Bom(bytes);
      if (matchesBinarySignature(stripped)) {
        skipped.push({ path: entryPath, reason: 'binary_signature' });
        continue;
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(stripped);
      } catch {
        skipped.push({ path: entryPath, reason: 'invalid_utf8' });
        continue;
      }
    }

    if (isYaml) {
      // YAML inside a zip uses the yaml's internal tree as the namespace —
      // the zip path is *not* prefixed. Creators reference yaml content via
      // its own keys (`__BoChars/female/modern__`), not via the wrapper
      // folder; prefixing would break those refs.
      const text = decodeUtf8(bytes);
      try {
        appendYamlCategories(text, entryPath, out);
      } catch (e) {
        // Re-throw with the entry path so the caller's invalidation reason
        // points at the offending file.
        throw new Error(
          `yaml parse failed for ${entryPath}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      continue;
    }

    // Use the full relative path as the category name. For `.txt` entries
    // we strip the extension; for extension-less entries we keep the path
    // as-is. Either way the result preserves any folder structure the
    // creator authored as part of the pack's namespace, so refs like
    // `__uds_wildcards/personmaker/adultage__` resolve correctly.
    const categoryName = isTxt ? stripTxtExtension(entryPath) : entryPath;
    if (!categoryName) continue;

    // The (wildcardSetId, name) unique key would catch dupes anyway, but
    // some zips contain duplicate entries for the same path (symlinks, OS
    // weirdness); first-write wins, rest are dropped silently.
    if (out.some((existing) => existing.name.toLowerCase() === categoryName.toLowerCase())) {
      continue;
    }

    const text = decodeUtf8(bytes);
    const lines = splitNonEmptyLines(text);
    if (lines.length === 0) continue;
    out.push({ name: categoryName, lines });
  }

  return { categories: out, skipped };
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= MAX_LINE_CHARS);
}

function getEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  // JSZip exposes uncompressedSize on the internal `_data` field. Not part
  // of the official public API but stable in v3 and the canonical accessor
  // everyone uses. Returns null if missing (e.g. a streamed zip without
  // central-directory size info), in which case callers fall back to
  // post-decode size checks.
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
}

// Strip a UTF-8 byte-order mark if present. Notepad/Windows tools commonly
// save text files with a BOM; without stripping it, the first wildcard line
// silently picks up an invisible U+FEFF prefix that breaks lookups.
function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  // Strip NUL bytes (U+0000). JavaScript happily carries them in strings,
  // but Postgres `text` / `text[]` columns reject them with SQLSTATE 22021
  // ("invalid byte sequence for encoding UTF8: 0x00") — one stray NUL in
  // any line aborts the entire `WildcardSetCategory.createMany` and the
  // import fails. We've observed real wildcard zips with embedded NULs
  // (looks like editor saves that include a trailing null terminator, or
  // files copied from binary sources). Strip at the decode boundary so
  // every downstream consumer (txt splitter, yaml parser, binary sniffer)
  // sees clean text.
  return new TextDecoder().decode(stripUtf8Bom(bytes)).replace(/\0/g, '');
}

// Magic-byte signatures for binary formats that occasionally show up in
// wildcard zips (usually as accidentally-committed assets or misnamed
// archives). Compared against the first N bytes of an extension-less entry
// to reject obvious binaries before we try to treat them as text.
const BINARY_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP / JAR / DOCX
  [0x50, 0x4b, 0x05, 0x06], // ZIP empty archive
  [0x50, 0x4b, 0x07, 0x08], // ZIP spanned
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x1f, 0x8b], // GZIP
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x42, 0x4d], // BMP
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x7f, 0x45, 0x4c, 0x46], // ELF (Linux executable)
  [0x4d, 0x5a], // Windows PE/MZ
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33], // SQLite
];

function matchesBinarySignature(bytes: Uint8Array): boolean {
  for (const sig of BINARY_SIGNATURES) {
    if (bytes.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// Filenames (lowercased, trailing dots stripped) that we should never treat
// as wildcard categories — these are documentation/config that commonly
// ships alongside wildcard data and would otherwise be ingested with their
// prose contents masquerading as category values.
const KNOWN_METADATA_NAMES = new Set([
  'readme',
  'license',
  'changelog',
  'authors',
  'contributors',
  'notice',
  'thanks',
  'copying',
  'manifest',
  'install',
  'todo',
  'bugs',
  'history',
  'news',
  'version',
  'makefile',
]);

function getBasename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function hasFileExtension(fileName: string): boolean {
  const lastDot = fileName.lastIndexOf('.');
  // `lastDot > 0` rejects dotfiles (`.gitignore` → lastDot=0).
  // `lastDot < length - 1` rejects trailing-dot weirdness (`foo.`).
  return lastDot > 0 && lastDot < fileName.length - 1;
}

function normalizeZipEntryPath(entryName: string): string {
  // Normalize Windows separators and strip leading `./` / `/` so paths from
  // any zip toolchain land in a single canonical form before we use them as
  // category names.
  return entryName.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function isMacOsResourceForkEntry(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  return fileName.startsWith('._');
}

function stripTxtExtension(name: string): string {
  return name.replace(/\.txt$/i, '');
}

function stripYamlExtension(name: string): string {
  return name.replace(/\.ya?ml$/i, '');
}

/**
 * Walk a parsed YAML tree depth-first; emit one `WildcardCategoryFile` per
 * leaf array (or scalar string leaf). The path from root to leaf, joined by
 * `/`, becomes the category name — matching how creators reference wildcards
 * across the pack (e.g. `__BoChars/female/modern__`).
 *
 * Mixed siblings work naturally: a node can have both array children
 * (leaves emitted as categories) and map children (recursed into) at the
 * same level. Existing entries in `out` win on name collisions — same
 * deterministic first-write-wins rule the txt path uses.
 */
function walkYamlTree(node: unknown, prefix: string, out: WildcardCategoryFile[]): void {
  if (Array.isArray(node)) {
    if (!prefix) return; // root-level array is handled by the caller
    if (out.some((existing) => existing.name.toLowerCase() === prefix.toLowerCase())) return;
    const lines = node
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length > 0) out.push({ name: prefix, lines });
    return;
  }

  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (!key) continue;
      const childPath = prefix ? `${prefix}/${key}` : key;
      walkYamlTree(child, childPath, out);
    }
    return;
  }

  // Scalar leaf — `key: "single value"` shorthand for a one-element pool.
  if (typeof node === 'string' && node.trim().length > 0 && prefix) {
    if (out.some((existing) => existing.name.toLowerCase() === prefix.toLowerCase())) return;
    out.push({ name: prefix, lines: [node.trim()] });
  }
}

function appendYamlCategories(text: string, fileName: string, out: WildcardCategoryFile[]): void {
  const parsed = yaml.load(text);

  // Top-level array → single category named after the file (mirrors the
  // bare-`.txt` shape). Keys inside the yaml define their own namespace, so
  // for an object root we pass an empty prefix.
  if (Array.isArray(parsed)) {
    const lines = parsed
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length === 0) return;
    const name = stripYamlExtension(fileName);
    if (!name) return;
    if (out.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) return;
    out.push({ name, lines });
    return;
  }

  if (parsed && typeof parsed === 'object') {
    walkYamlTree(parsed, '', out);
    return;
  }

  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    const name = stripYamlExtension(fileName);
    if (!name) return;
    if (out.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) return;
    out.push({ name, lines: [parsed.trim()] });
  }
}

function parseYamlCategories(text: string, fileName: string): WildcardCategoryFile[] {
  const out: WildcardCategoryFile[] = [];
  appendYamlCategories(text, fileName, out);
  return out;
}

export function pickPrimaryWildcardFile<T extends { name: string }>(files: T[]): T | undefined {
  const supported = files.filter((f) => getSupportedExtension(f.name) !== null);
  if (supported.length === 0) return undefined;
  const byPriority = (file: T) => {
    const ext = getSupportedExtension(file.name);
    if (ext === '.zip') return 0;
    if (ext === '.yaml' || ext === '.yml') return 1;
    if (ext === '.txt') return 2;
    return 3;
  };
  return supported.sort((a, b) => byPriority(a) - byPriority(b))[0];
}

/**
 * Resolve the primary wildcard source `ModelFile` for a given `Wildcards`-type
 * ModelVersion. This is the file that carries the post-Phase-2
 * `metadata.wildcardSet` mirror — provisioning, the audit verdict path, the
 * invalidation toggle, and the reconciliation cron all converge on this
 * same predicate so exactly one file per version owns the blob.
 *
 * Returns `undefined` when the version has no supported wildcard file (or
 * no files at all) — callers should treat that as "no mirror exists for this
 * version" rather than an error.
 *
 * Accepts an optional `db` so writers can pass their transactional client
 * (`prisma.$transaction(async (tx) => …)`) and get a consistent read of
 * just-written rows; defaults to `dbWrite` so ad-hoc callers see the
 * primary's state without replica lag.
 *
 * See docs/wildcard-moderation-pipeline-cleanup.md §Phase 2 "Sync contract"
 * rule 2 (target-file identification) for the contract this implements.
 */
export async function getWildcardSourceFile(
  modelVersionId: number,
  db: Pick<typeof dbWrite, 'modelFile'> = dbWrite
): Promise<{ id: number; name: string } | undefined> {
  const files = await db.modelFile.findMany({
    where: { modelVersionId },
    select: { id: true, name: true },
  });
  return pickPrimaryWildcardFile(files);
}

/**
 * Persist a stub WildcardSet row marked invalidated so the reconcile cron's
 * `wildcardSet: null` filter stops re-trying versions whose primary file is
 * structurally unusable (corrupt zip, no .txt entries, missing primary file).
 * Transient transport failures (URL resolve, DB transaction timeout) stay on
 * the `failed` path and continue to retry.
 */
async function markWildcardVersionInvalidated(
  modelVersion: { id: number; name: string; modelName: string },
  reason: string,
  skippedEntries?: SkippedEntry[]
): Promise<ImportWildcardModelVersionResult> {
  // Only attach metadata when there's something useful to record so the
  // column stays NULL for the common case rather than holding `{}`.
  const metadata = skippedEntries && skippedEntries.length > 0 ? { skippedEntries } : undefined;
  try {
    const set = await dbWrite.wildcardSet.create({
      data: {
        kind: 'System',
        modelVersionId: modelVersion.id,
        name: `${modelVersion.modelName} - ${modelVersion.name}`,
        auditStatus: 'Pending',
        isInvalidated: true,
        invalidationReason: reason,
        invalidatedAt: new Date(),
        metadata,
      },
      select: { id: true },
    });
    return { status: 'invalidated', wildcardSetId: set.id, reason };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const winner = await dbRead.wildcardSet.findUnique({
        where: { modelVersionId: modelVersion.id },
        select: { id: true },
      });
      if (winner) return { status: 'already_exists', wildcardSetId: winner.id };
    }
    return {
      status: 'failed',
      error: `failed to mark invalidated: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Idempotent core. Creates the `WildcardSet` + `WildcardSetCategory` rows for
 * a single published wildcard `ModelVersion`. Returns `already_exists` if a
 * set already points at the version (including the unique-violation race
 * path). Errors are returned as `{ status: 'failed', error }` rather than
 * thrown so callers (the cron, the admin endpoint) can keep processing the
 * rest of the batch without unwinding.
 */
export async function importWildcardModelVersion(
  modelVersionId: number
): Promise<ImportWildcardModelVersionResult> {
  // 1. Fast-path: short-circuit when the set already exists. The unique
  //    constraint also enforces this at write time below.
  const existing = await dbRead.wildcardSet.findUnique({
    where: { modelVersionId },
    select: { id: true },
  });
  if (existing) return { status: 'already_exists', wildcardSetId: existing.id };

  // 2. Load the version, its model type, and its files. All wildcard files are
  //    currently shipped via ModelFile (matches scan-files.ts patterns).
  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      name: true,
      status: true,
      model: { select: { type: true, name: true } },
      files: { select: { id: true, name: true, url: true, sizeKB: true } },
    },
  });
  if (!modelVersion) return { status: 'failed', error: 'model version not found' };
  if (modelVersion.model.type !== WILDCARD_MODEL_TYPE) {
    return {
      status: 'failed',
      error: `not a Wildcards-type model (got ${modelVersion.model.type})`,
    };
  }

  const primary = pickPrimaryWildcardFile(modelVersion.files);
  if (!primary) {
    // Distinguish "version has zero files" (genuinely broken — invalidate)
    // from "version has files but none in a format we currently support"
    // (signal upstream — don't invalidate, we'll come back when we add the
    // format).
    if (modelVersion.files.length === 0) {
      return markWildcardVersionInvalidated(
        { id: modelVersionId, name: modelVersion.name, modelName: modelVersion.model.name },
        'no primary file on model version'
      );
    }
    return {
      status: 'unsupported_format',
      fileNames: modelVersion.files.map((f) => f.name),
    };
  }

  // Pre-fetch size guard. ModelFile.sizeKB is recorded at upload time; if it
  // already exceeds our cap there's no value in resolving + downloading the
  // file just to reject it post-decode. For zips this is the *compressed*
  // size — uncompressed is always >= compressed, so a zip whose compressed
  // size already busts the uncompressed cap is guaranteed to fail.
  const ext = getSupportedExtension(primary.name);
  const primaryBytes = Math.round(primary.sizeKB * 1024);
  const preFetchLimit =
    ext === '.zip'
      ? MAX_ZIP_UNCOMPRESSED_BYTES
      : ext === '.yaml' || ext === '.yml'
      ? MAX_YAML_FILE_BYTES
      : MAX_TXT_FILE_BYTES;
  if (primaryBytes > preFetchLimit) {
    return markWildcardVersionInvalidated(
      { id: modelVersionId, name: modelVersion.name, modelName: modelVersion.model.name },
      `primary file too large pre-fetch: ${primaryBytes} bytes (${primary.name}) exceeds limit ${preFetchLimit}`
    );
  }

  // 3. Resolve a presigned download URL the same way scan-files.ts does, then
  //    pull the bytes into memory. Wildcard zips are tiny (KBs to a few MBs)
  //    so streaming isn't worth the complexity here.
  let downloadInfo;
  try {
    downloadInfo = await resolveDownloadUrl(primary.id, primary.url, primary.name);
  } catch (e) {
    return {
      status: 'failed',
      error: `failed to resolve download url: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Download (transient on failure) and parse (persistent on failure) are
  // split so a flaky S3 response doesn't get bucketed as "corrupt zip".
  let buffer: ArrayBuffer;
  try {
    buffer = await downloadPrimaryFileBytes(downloadInfo.url);
  } catch (e) {
    return {
      status: 'failed',
      error: `download failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let categories: WildcardCategoryFile[];
  let skippedEntries: SkippedEntry[];
  try {
    const parsed = await parseWildcardCategoriesFromBuffer(buffer, primary.name);
    categories = parsed.categories;
    skippedEntries = parsed.skipped;
  } catch (e) {
    return markWildcardVersionInvalidated(
      { id: modelVersionId, name: modelVersion.name, modelName: modelVersion.model.name },
      `parse failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (categories.length === 0) {
    // Pass through skipped entries — when the only reason no categories
    // were produced is that everything got skipped (oversized, binary,
    // etc.), the metadata explains *why* there's nothing to ingest.
    return markWildcardVersionInvalidated(
      { id: modelVersionId, name: modelVersion.name, modelName: modelVersion.model.name },
      'no non-empty .txt categories found in primary file',
      skippedEntries
    );
  }

  // Pathological-structure guard: a malformed pack can decode into thousands
  // of leaf categories (e.g. a yaml whose every line lands as its own leaf).
  // The biggest legit pack we've sampled has ~190; 5,000 is firmly past the
  // realistic ceiling. Marking invalidated keeps the cron from re-trying.
  if (categories.length > MAX_CATEGORIES_PER_SET) {
    return markWildcardVersionInvalidated(
      { id: modelVersionId, name: modelVersion.name, modelName: modelVersion.model.name },
      `too many categories: ${categories.length} exceeds limit ${MAX_CATEGORIES_PER_SET}`
    );
  }

  // 4. Normalize Dynamic Prompts nested refs in every line.
  for (const category of categories) {
    category.lines = category.lines.map(normalizeNestedRefs);
  }

  const totalValueCount = categories.reduce((sum, c) => sum + c.lines.length, 0);

  // 5. Single transaction: WildcardSet + N WildcardSetCategory rows, atomic.
  //    Default Prisma timeout is 5s, which the larger packs (200+ categories
  //    with long text[] rows — the uds pack has ~190 across nested folders)
  //    blow through; bump to 60s to comfortably cover the biggest known
  //    wildcard models.
  // Stash skipped entries on the set so creators/admins can see why a file
  // they uploaded didn't show up — without having to grep Axiom. Stays NULL
  // when the import was a clean sweep so we don't bloat the column.
  const setMetadata = skippedEntries.length > 0 ? { skippedEntries } : undefined;

  try {
    const created = await dbWrite.$transaction(
      async (tx) => {
        const set = await tx.wildcardSet.create({
          data: {
            kind: 'System',
            modelVersionId,
            name: `${modelVersion.model.name} - ${modelVersion.name}`,
            auditStatus: 'Pending',
            metadata: setMetadata,
          },
          select: { id: true },
        });

        // createMany supports text[] and is one round-trip; we forfeit per-row
        // displayOrder unless we set it explicitly here, which we do.
        await tx.wildcardSetCategory.createMany({
          data: categories.map((category, index) => ({
            wildcardSetId: set.id,
            name: category.name,
            values: category.lines,
            valueCount: category.lines.length,
            displayOrder: index,
            auditStatus: 'Pending',
            nsfw: false,
          })),
        });

        return set.id;
      },
      { timeout: 60_000 }
    );

    // Kick off per-category XGuard audits in the background. Fire-and-forget:
    // import shouldn't block on orchestrator latency, and the periodic
    // `audit-wildcard-set-categories` cron is the safety net if anything
    // here silently fails. Categories sit at `auditStatus = 'Pending'` until
    // the webhook callback lands and writes the rollup.
    submitWildcardSetAudit(created).catch((err) =>
      logToAxiom({
        type: 'error',
        name: 'wildcard-set-provisioning',
        message: 'failed to schedule audits after import',
        wildcardSetId: created,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    );

    return {
      status: 'created',
      wildcardSetId: created,
      categoryCount: categories.length,
      valueCount: totalValueCount,
      skippedEntries,
    };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // Concurrent first-import — another caller won the unique-modelVersionId
      // race. Re-read and treat as already_exists.
      const winner = await dbRead.wildcardSet.findUnique({
        where: { modelVersionId },
        select: { id: true },
      });
      if (winner) return { status: 'already_exists', wildcardSetId: winner.id };
    }
    return {
      status: 'failed',
      error: `transaction failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export type ReconcileWildcardSetsResult = {
  // Loud, top-of-result strings flagging anything that needs human attention
  // (currently: model versions whose primary file extension we don't yet
  // support, plus zip entries that got skipped during otherwise-successful
  // imports). Empty when everything's clean — readers can guard on length.
  warnings: string[];
  scanned: number;
  created: number;
  invalidated: number;
  unsupportedFormat: number;
  alreadyExists: number;
  failed: number;
  entriesSkipped: number;
  // Detailed unsupported-format breakdown so we can quickly see which models
  // need new format support and what their files look like. Sorted by
  // modelVersionId for stable diffing.
  unsupportedModels: {
    modelVersionId: number;
    modelName: string;
    versionName: string;
    files: string[];
  }[];
  // Per-entry skips that landed during successful imports — creators who
  // wonder why a category they uploaded didn't show up can find their file
  // here with the reason. Reason is one of `oversized`, `binary_signature`,
  // or `invalid_utf8`.
  skippedEntries: {
    modelVersionId: number;
    path: string;
    reason: SkippedEntry['reason'];
    sizeBytes?: number;
  }[];
  failures: { modelVersionId: number; error: string }[];
};

/**
 * Scan for published `Wildcards`-type model versions that don't yet have a
 * `WildcardSet` and import each one. Used by both the periodic cron and the
 * admin debug endpoint. Capped per call so a backfill doesn't run
 * unbounded — rerun until `scanned` is 0.
 */
export async function reconcileWildcardSets(opts?: {
  limit?: number;
}): Promise<ReconcileWildcardSetsResult> {
  const limit = Math.max(1, Math.min(opts?.limit ?? RECONCILE_BATCH_SIZE, 500));

  const unimported = await dbRead.modelVersion.findMany({
    where: {
      status: 'Published',
      model: { type: WILDCARD_MODEL_TYPE },
      wildcardSet: null,
    },
    select: {
      id: true,
      name: true,
      model: { select: { name: true } },
    },
    take: limit,
    orderBy: { id: 'asc' },
  });

  const result: ReconcileWildcardSetsResult = {
    warnings: [],
    scanned: unimported.length,
    created: 0,
    invalidated: 0,
    unsupportedFormat: 0,
    alreadyExists: 0,
    failed: 0,
    entriesSkipped: 0,
    unsupportedModels: [],
    skippedEntries: [],
    failures: [],
  };

  for (const mv of unimported) {
    const outcome = await importWildcardModelVersion(mv.id);
    switch (outcome.status) {
      case 'created':
        result.created++;
        for (const skip of outcome.skippedEntries) {
          result.entriesSkipped++;
          result.skippedEntries.push({ modelVersionId: mv.id, ...skip });
          logToAxiom({
            type: 'wildcard-set-provisioning',
            name: 'reconcile-wildcard-sets',
            level: 'info',
            message: 'skipped zip entry during wildcard import',
            modelVersionId: mv.id,
            path: skip.path,
            reason: skip.reason,
            sizeBytes: skip.sizeBytes,
          }).catch(() => undefined);
        }
        break;
      case 'invalidated':
        result.invalidated++;
        logToAxiom({
          type: 'wildcard-set-provisioning',
          name: 'reconcile-wildcard-sets',
          level: 'info',
          message: 'marked wildcard model version invalidated',
          modelVersionId: mv.id,
          wildcardSetId: outcome.wildcardSetId,
          reason: outcome.reason,
        }).catch(() => undefined);
        break;
      case 'unsupported_format':
        result.unsupportedFormat++;
        result.unsupportedModels.push({
          modelVersionId: mv.id,
          modelName: mv.model.name,
          versionName: mv.name,
          files: outcome.fileNames,
        });
        logToAxiom({
          type: 'wildcard-set-provisioning',
          name: 'reconcile-wildcard-sets',
          level: 'warn',
          message: 'wildcard model version has unsupported primary file format',
          modelVersionId: mv.id,
          modelName: mv.model.name,
          versionName: mv.name,
          files: outcome.fileNames,
        }).catch(() => undefined);
        break;
      case 'already_exists':
        result.alreadyExists++;
        break;
      case 'failed':
        result.failed++;
        result.failures.push({ modelVersionId: mv.id, error: outcome.error });
        logToAxiom({
          type: 'wildcard-set-provisioning',
          name: 'reconcile-wildcard-sets',
          level: 'warn',
          message: 'failed to import wildcard model version',
          modelVersionId: mv.id,
          error: outcome.error,
        }).catch(() => undefined);
        break;
    }
  }

  if (result.unsupportedFormat > 0) {
    result.warnings.push(
      `⚠️  ${
        result.unsupportedFormat
      } model version(s) use primary file format(s) we do not yet support — these are NOT marked invalidated and will retry on the next reconcile pass. See "unsupportedModels" below; supported extensions today: ${SUPPORTED_EXTENSIONS.join(
        ', '
      )}.`
    );
  }

  if (result.entriesSkipped > 0) {
    result.warnings.push(
      `ℹ️  ${result.entriesSkipped} zip entr(ies) were skipped during otherwise-successful imports (oversized / binary / invalid UTF-8). See "skippedEntries" below; these categories will be missing from their wildcard sets until the creator fixes the offending file and republishes.`
    );
  }

  return result;
}
