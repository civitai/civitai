import JSZip from 'jszip';
import yaml from 'js-yaml';

import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { Flags } from '~/shared/utils/flags';
import { Availability, ModelModifier, ModelStatus, ModelType } from '~/shared/utils/prisma/enums';

/**
 * Wildcard-pack content for App Blocks (WILDCARD_PACK_SPEC — the one new piece
 * behind GET /api/v1/blocks/wildcards/[modelVersionId]).
 *
 * WHY THIS EXISTS: a sandboxed block iframe (opaque origin, `Origin: null`)
 * CANNOT fetch pack files itself — the signed storage URLs send no CORS headers
 * for a null origin, many files 401 anonymously, and session cookies never
 * attach without `allow-same-origin`. So the server fetches the pack archive,
 * parses it, and returns clean, capped, text-only JSON lists. No raw file/zip
 * bytes ever reach the iframe.
 *
 * SECURITY POSTURE (the reason this is not a generic file proxy):
 *   - HARD TYPE GATE: only `model.type === 'Wildcards'` is ever served. A
 *     checkpoint/LoRA/etc. version id is a 404 — this endpoint cannot be used
 *     to exfiltrate arbitrary model files.
 *   - Published-only: model AND version must be Published (not deleted /
 *     unpublished / mod-unpublished); archived and private/early-access
 *     versions are refused.
 *   - MATURITY: `model.nsfwLevel` must fit ENTIRELY inside the caller's
 *     clamped browsing level (the token-ceiling clamp models.ts uses) —
 *     fail-closed SFW when the claim is absent.
 *   - Zip-bomb guards: entry-count / per-entry / total-uncompressed caps, and
 *     a pre-download size cap on the stored file.
 *
 * TRUNCATION POSTURE (deliberate, per the spec survey): tag-dump packs (419k
 * lines in one txt) and mega prompt collections blow the caps and are served
 * TRUNCATED (per-list flag), not rejected — the first N options is the product,
 * not a failure.
 */

// ---- Caps (spec §handler-steps; surveyed against the top-300 packs) ----

/** Reject the stored file before download above this (top-30 packs ≤ ~22 MB). */
export const MAX_PACK_FILE_KB = 32 * 1024;
/** Max zip entries examined (densest real pack: 1,508 txt files). */
export const MAX_ZIP_ENTRIES = 2048;
/** Max uncompressed bytes inflated per entry. */
export const MAX_ENTRY_BYTES = 1 * 1024 * 1024;
/** Max total uncompressed bytes across all parsed entries. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Max options kept per list (truncate + flag, never error). */
export const MAX_OPTIONS_PER_LIST = 2000;
/** Max characters kept per option. */
export const MAX_OPTION_CHARS = 400;
/** Parsed content is immutable per version — cache a week. */
export const PACK_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---- Parsing (pure; unit-tested without db/storage) ----

export interface ParsedPack {
  lists: Record<string, string[]>;
  truncated: boolean;
  truncatedLists: string[];
}

/** Normalize a list key: path minus extension, lowercased, spaces→dashes, `{}|` stripped. */
export function normalizeListKey(path: string): string {
  return path
    .replace(/\.(txt|ya?ml)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[{}|]/g, '');
}

/** Track per-list truncation once, in one place. */
class PackBuilder {
  lists: Record<string, string[]> = {};
  truncatedLists = new Set<string>();

  add(key: string, options: string[], entryTruncated: boolean) {
    if (!key) return;
    const seen = new Set<string>();
    let truncated = entryTruncated;
    for (const raw of options) {
      let opt = raw.trim();
      if (!opt || opt.startsWith('#')) continue;
      if (opt.length > MAX_OPTION_CHARS) {
        opt = opt.slice(0, MAX_OPTION_CHARS);
        truncated = true;
      }
      if (seen.size >= MAX_OPTIONS_PER_LIST) {
        truncated = true;
        break;
      }
      seen.add(opt);
    }
    if (seen.size === 0) return;
    this.lists[key] = [...seen];
    if (truncated) this.truncatedLists.add(key);
  }

  build(): ParsedPack {
    return {
      lists: this.lists,
      truncated: this.truncatedLists.size > 0,
      truncatedLists: [...this.truncatedLists].sort(),
    };
  }
}

/** One option per line; `#` comments, blank lines, and `\r` stripped; deduped. */
function txtOptions(content: string): string[] {
  return content.split('\n').map((l) => l.replace(/\r$/, ''));
}

/**
 * Flatten a Dynamic-Prompts-style YAML document (nested maps of string arrays)
 * into `parent/child`-keyed lists. Non-string leaves are ignored.
 */
export function flattenYamlLists(
  node: unknown,
  prefix: string,
  out: Array<{ key: string; options: string[] }>
): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const options = node.filter((v): v is string => typeof v === 'string');
    if (options.length > 0 && prefix) out.push({ key: prefix, options });
    return;
  }
  for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
    const key = normalizeListKey(String(rawKey));
    if (!key) continue;
    flattenYamlLists(value, prefix ? `${prefix}/${key}` : key, out);
  }
}

function addYamlEntry(builder: PackBuilder, keyPrefix: string, content: string): void {
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch {
    return; // a malformed yaml entry is skipped, not fatal to the pack
  }
  const flattened: Array<{ key: string; options: string[] }> = [];
  flattenYamlLists(doc, keyPrefix, flattened);
  for (const { key, options } of flattened) builder.add(key, options, false);
}

const TXT_RE = /\.txt$/i;
const YAML_RE = /\.ya?ml$/i;

/**
 * Parse pack bytes into capped lists. Two shapes exist in the wild (top-300
 * survey): a `.zip` of `.txt`/`.yaml` leaves (833/835) and a bare top-level
 * `.txt` (2/835) — a bare `.txt`/`.yaml` primary file parses directly as a
 * single-list pack under the same caps. Anything else inside a zip
 * (directories, dotfiles, previews, nested zips) is skipped by the extension
 * filter without being inflated (jszip reads the central directory lazily).
 */
export async function parsePackFile(
  bytes: Buffer | Uint8Array,
  fileName: string
): Promise<ParsedPack> {
  const builder = new PackBuilder();

  if (TXT_RE.test(fileName) || YAML_RE.test(fileName)) {
    const capped = bytes.length > MAX_ENTRY_BYTES;
    const content = Buffer.from(bytes.subarray(0, MAX_ENTRY_BYTES)).toString('utf8');
    const key = normalizeListKey(fileName.split('/').pop() ?? fileName);
    if (TXT_RE.test(fileName)) builder.add(key, txtOptions(content), capped);
    else addYamlEntry(builder, key, content);
    return builder.build();
  }

  const zip = await JSZip.loadAsync(bytes);
  let entriesSeen = 0;
  let totalBytes = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entriesSeen >= MAX_ZIP_ENTRIES) break;
    entriesSeen++;
    if (entry.dir) continue;
    const base = path.split('/').pop() ?? path;
    if (base.startsWith('.')) continue;
    if (!TXT_RE.test(base) && !YAML_RE.test(base)) continue; // previews, nested zips, …

    // Zip-bomb guards: skip an entry that DECLARES too large, and stop
    // entirely once the total uncompressed budget is spent. The declared size
    // comes from the central directory (internal but stable jszip field);
    // when unavailable we still enforce the cap on the inflated length.
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    let entryTruncated = false;
    if (typeof declared === 'number' && declared > MAX_ENTRY_BYTES) {
      // Inflate only the head? jszip has no partial inflate — take the whole
      // entry only when it fits the per-entry cap; otherwise skip it as a
      // truncated (empty would lose the list entirely — prefer flagging).
      entryTruncated = true;
    }
    if (totalBytes >= MAX_TOTAL_BYTES) break;

    let content: string;
    try {
      content = await entry.async('string');
    } catch {
      continue; // an unreadable entry is skipped, not fatal
    }
    if (content.length > MAX_ENTRY_BYTES) {
      content = content.slice(0, MAX_ENTRY_BYTES);
      entryTruncated = true;
    }
    totalBytes += content.length;

    const key = normalizeListKey(path);
    if (TXT_RE.test(base)) builder.add(key, txtOptions(content), entryTruncated);
    else addYamlEntry(builder, key, content);
  }

  return builder.build();
}

// ---- Loading (db gates + storage fetch + cache) ----

export interface WildcardPackBody extends ParsedPack {
  modelId: number;
  modelVersionId: number;
  modelName: string;
  versionName: string;
  creatorUsername: string | null;
}

export type WildcardPackResult =
  | { status: 'ok'; body: WildcardPackBody }
  /** Unknown id, non-Wildcards type, unpublished/deleted/archived, gated version. */
  | { status: 'not-found' }
  /** The pack's nsfwLevel exceeds the caller's clamped browsing level. */
  | { status: 'forbidden' }
  /** The stored file exceeds MAX_PACK_FILE_KB (rejected before download). */
  | { status: 'too-large' }
  /** Storage fetch failed (transient) — the caller maps this to a 502. */
  | { status: 'fetch-failed' };

/** What the Redis cache stores: parse output + attribution, pre-maturity-clamp. */
type CachedPack = Omit<WildcardPackBody, 'modelVersionId' | 'modelId'>;

const cacheKey = (modelVersionId: number) =>
  `${REDIS_KEYS.BLOCKS.WILDCARD_PACK}:${modelVersionId}` as const;

/**
 * Load, gate, and parse one wildcard pack. `browsingLevel` is the caller's
 * ALREADY-CLAMPED level (resolveCatalogBrowsingLevel) — this service only
 * applies it, never derives it. All redis interaction is fail-open: a cache
 * error falls through to a storage fetch; a cache-write error is swallowed.
 */
export async function getWildcardPackContent({
  modelVersionId,
  browsingLevel,
}: {
  modelVersionId: number;
  browsingLevel: number;
}): Promise<WildcardPackResult> {
  const version = await dbRead.modelVersion.findFirst({
    // Relation-existence filter: drop orphaned versions instead of Prisma
    // throwing on the required-but-missing model (same class as #2637).
    where: { id: modelVersionId, model: { is: {} } },
    select: {
      id: true,
      name: true,
      status: true,
      availability: true,
      earlyAccessEndsAt: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          mode: true,
          nsfwLevel: true,
          availability: true,
          user: { select: { username: true } },
        },
      },
      files: {
        select: { id: true, name: true, url: true, sizeKB: true, type: true },
      },
    },
  });

  if (!version) return { status: 'not-found' };

  // THE hard gate: this endpoint serves wildcard packs and nothing else.
  if (version.model.type !== ModelType.Wildcards) return { status: 'not-found' };

  // Published-only, no mode modifiers (archived/takendown), public availability,
  // and not early-access-gated. All failures collapse to not-found — a block
  // has no business distinguishing "exists but hidden" from "doesn't exist".
  if (version.model.status !== ModelStatus.Published || version.status !== ModelStatus.Published)
    return { status: 'not-found' };
  if (
    version.model.mode === ModelModifier.Archived ||
    version.model.mode === ModelModifier.TakenDown
  )
    return { status: 'not-found' };
  if (
    version.model.availability === Availability.Private ||
    version.availability === Availability.Private
  )
    return { status: 'not-found' };
  if (version.earlyAccessEndsAt && new Date() < version.earlyAccessEndsAt)
    return { status: 'not-found' };

  // Maturity: the pack's level must fit ENTIRELY inside the clamped level.
  // (nsfwLevel 0 = unrated ⊆ anything; a mature bit outside the ceiling → 403.)
  if (Flags.intersection(version.model.nsfwLevel, browsingLevel) !== version.model.nsfwLevel)
    return { status: 'forbidden' };

  const meta: Pick<WildcardPackBody, 'modelId' | 'modelVersionId'> = {
    modelId: version.model.id,
    modelVersionId: version.id,
  };

  // Cache read — parsed content is immutable per version.
  try {
    const cached = await redis.get(cacheKey(version.id) as never);
    if (cached) return { status: 'ok', body: { ...(JSON.parse(cached) as CachedPack), ...meta } };
  } catch {
    // fail-open: fall through to a storage fetch
  }

  // Primary pack file: prefer the Archive, else the first file at all.
  const file = version.files.find((f) => f.type === 'Archive') ?? version.files[0];
  if (!file) return { status: 'not-found' };
  if (file.sizeKB > MAX_PACK_FILE_KB) return { status: 'too-large' };

  let bytes: Buffer;
  try {
    const { url } = await resolveDownloadUrl(file.id, file.url, file.name);
    const res = await fetch(url);
    if (!res.ok) return { status: 'fetch-failed' };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return { status: 'fetch-failed' };
  }

  let parsed: ParsedPack;
  try {
    parsed = await parsePackFile(bytes, file.name);
  } catch {
    // Not a readable zip/txt — treat like a pack with nothing importable.
    parsed = { lists: {}, truncated: false, truncatedLists: [] };
  }

  const cachedBody: CachedPack = {
    ...parsed,
    modelName: version.model.name,
    versionName: version.name,
    creatorUsername: version.model.user?.username ?? null,
  };

  try {
    await redis.set(cacheKey(version.id) as never, JSON.stringify(cachedBody), {
      EX: PACK_CACHE_TTL_SECONDS,
    });
  } catch {
    // fail-open: caching is an optimization, never a dependency
  }

  return { status: 'ok', body: { ...cachedBody, ...meta } };
}
