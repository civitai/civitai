/**
 * Flatten an App Blocks shared-storage `data` blob into the TEXT it carries, for moderation.
 *
 * `data` is app-owned JSON stored beside the moderated `title`/`body`. Every string in it can be
 * rendered to other users by the app, and so can every object KEY — an app that renders
 * `Object.keys(data.tags)` shows its users exactly what a string value would. So a leaf here is
 * either kind, and both are scanned.
 *
 * PURE: no I/O, no flags, no logging. The caller decides what a leaf costs.
 *
 * Input contract: `data` is the value AFTER a JSON round trip (`JSON.parse(JSON.stringify(x))`),
 * i.e. exactly what is stored. The router hands this the parsed form of the serialized value it is
 * about to write, so superjson-revived values (a `Date`, a `Map`) arrive already in their stored
 * shape (an ISO string, `{}`) and the walker never has to reason about `toJSON`. Anything that is
 * not a plain JSON value is skipped rather than coerced — it cannot occur on that input.
 *
 * Caps exist so one write's moderation cost is bounded, and every cap reports `overflow` rather
 * than silently truncating: a truncated scan would let text past the cap through unread, which is
 * the evasion a cap must not open. The router rejects an overflow in enforce mode and records it
 * in shadow mode.
 */

/** Maximum nesting of containers. The root object is depth 1. */
export const SHARED_DATA_MAX_DEPTH = 32;
/** Maximum number of DISTINCT leaf strings (values and keys together, after dedupe). */
export const SHARED_DATA_MAX_LEAVES = 1000;
/** Maximum total characters over the distinct leaves (raw lengths). */
export const SHARED_DATA_MAX_CHARS = 64_000;

export type SharedDataLeafKind = 'value' | 'key';

export interface SharedDataLeaf {
  /**
   * The leaf exactly as stored. The checks do NOT read this as-is: `classifySharedTexts` strips
   * every invisible character from it first (`stripInvisible`), and the record keeps it raw.
   */
  raw: string;
  /**
   * JSON-pointer-style path of the FIRST occurrence, e.g. `x/tags/0`. A `key` leaf's path is the
   * path of the member it names — `kind` is what tells the two apart.
   */
  path: string;
  /**
   * The same path as its parts: a NUMBER is an array index (platform structure), a STRING is an
   * object key (user text). `path` cannot tell the two apart — `{"0": …}` and `[…]` both give `0` —
   * and a recorder that must not store user text needs to (see `sharedDataHitRows`).
   */
  segments: ReadonlyArray<string | number>;
  kind: SharedDataLeafKind;
}

export type SharedDataOverflow = 'depth' | 'leaves' | 'chars';

export type CollectSharedDataLeavesResult =
  | { leaves: SharedDataLeaf[] }
  | { overflow: SharedDataOverflow };

/** Escape a path segment so `/` inside a key cannot forge a path. */
function segment(part: string | number): string {
  return String(part).replace(/~/g, '~0').replace(/\//g, '~1');
}

function join(path: string, part: string | number): string {
  return path ? `${path}/${segment(part)}` : segment(part);
}

/**
 * Iterative DFS over a JSON value. Iterative, not recursive, so the depth cap is the only bound on
 * nesting and a hostile shape cannot reach the engine's stack limit first.
 */
export function collectSharedDataLeaves(data: unknown): CollectSharedDataLeavesResult {
  // Exact strings are deduped: a repeated leaf is read once, at its first path.
  const byRaw = new Map<string, SharedDataLeaf>();
  let totalChars = 0;

  // Returns an overflow when adding this leaf breaks a cap, else undefined.
  const add = (
    raw: string,
    path: string,
    segments: ReadonlyArray<string | number>,
    kind: SharedDataLeafKind
  ): SharedDataOverflow | void => {
    if (byRaw.has(raw)) return;
    if (byRaw.size + 1 > SHARED_DATA_MAX_LEAVES) return 'leaves';
    totalChars += raw.length;
    if (totalChars > SHARED_DATA_MAX_CHARS) return 'chars';
    byRaw.set(raw, { raw, path, segments, kind });
  };

  // `depth` is the nesting level of the container being pushed; scalars carry their parent's.
  const stack: Array<{
    value: unknown;
    path: string;
    segments: ReadonlyArray<string | number>;
    depth: number;
  }> = [{ value: data, path: '', segments: [], depth: 0 }];

  while (stack.length) {
    const { value, path, segments, depth } = stack.pop()!;

    if (typeof value === 'string') {
      const overflow = add(value, path, segments, 'value');
      if (overflow) return { overflow };
      continue;
    }
    // Numbers, booleans and null carry no text. Anything else cannot occur after a JSON round trip.
    if (value === null || typeof value !== 'object') continue;

    const containerDepth = depth + 1;
    if (containerDepth > SHARED_DATA_MAX_DEPTH) return { overflow: 'depth' };

    if (Array.isArray(value)) {
      // Reverse push so the walk visits elements in order (first path wins for duplicates).
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({
          value: value[i],
          path: join(path, i),
          segments: [...segments, i],
          depth: containerDepth,
        });
      }
      continue;
    }

    const keys = Object.keys(value);
    // Keys are leaves of the container that holds them, collected before its children so a key
    // takes the first-occurrence slot over the same string appearing deeper inside.
    for (const key of keys) {
      const overflow = add(key, join(path, key), [...segments, key], 'key');
      if (overflow) return { overflow };
    }
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      stack.push({
        value: (value as Record<string, unknown>)[key],
        path: join(path, key),
        segments: [...segments, key],
        depth: containerDepth,
      });
    }
  }

  return { leaves: [...byRaw.values()] };
}
