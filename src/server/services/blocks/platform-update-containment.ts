/**
 * Does a tree hold a staff platform update's change? ONE predicate for every place that asks:
 * the submit and approve checks on an app's bundle (`platform-update-bundle-check.ts`), and App
 * Assistant's report that it merged an update (`runner-platform-updates.ts`).
 *
 * Pure: the caller reads the bytes. For each path the update's record lists, three sides:
 *   - `want`: the file at the update's `commitSha` (`null` when the update deletes it);
 *   - `base`: the file at its `baseCommitSha` (`null` when it was not there);
 *   - `have`: the file in the tree being checked (`null` when that tree lacks it).
 *
 * A path holds the update when:
 *   - the update deletes it: the tree lacks it;
 *   - the tree's file is byte-for-byte the update's;
 *   - or the file was merged by hand (the owner's edits beside the update's). Every side must be
 *     UTF-8 text. Lines are compared exactly, after the line ending (CRLF and LF are one), and
 *     blank lines are not counted. The update's change is the lines it adds to its base and the
 *     lines it removes from it, COUNTED (a line the update adds a second copy of is one added
 *     line). For each line `l`, with `base(l)`, `want(l)`, `have(l)` its number of occurrences on
 *     each side:
 *       - a line the update adds (`want(l) > base(l)`): `have(l) >= want(l)`, that is the base's
 *         copies plus every added one;
 *       - a line the update removes (`want(l) < base(l)`): `have(l) <= want(l)`, that is the
 *         base's copies minus every removed one.
 *     An update that adds and removes nothing (it only reorders lines, or changes blank lines or
 *     line endings) holds only with the exact bytes, so a hand-merge never holds it.
 * A file that is not text on some side must be exactly the update's.
 *
 * DEPENDENCY FILES (a path named `package.json` or `pnpm-lock.yaml`, at any depth) also hold the
 * update when every side parses and the tree has each dependency change the update makes, whatever
 * else differs (an owner's later bumps of other packages, key order, formatting). A lockfile's
 * unrelated churn can never satisfy the line check above, so without this an update that bumps
 * a package could only be merged by taking the staff lockfile whole. Either reading holding is
 * enough; a file that does not parse gets only the line check (as before this rule).
 *   - `package.json` (JSON): every value the update changes, compared key by key down through
 *     objects (so `dependencies["@civitai/sdk"]`, not the whole `dependencies` object; arrays and
 *     scalars as wholes), must equal the update's in the tree, and every key it removes must be
 *     absent there.
 *   - `pnpm-lock.yaml` ({@link pnpmDirectDependencies}: the last YAML document, each importer's
 *     direct dependencies, peer suffix stripped): every package the update pins to a new version
 *     must resolve to that version in the same importer, and every package it drops must not be
 *     there. Transitive entries are not compared.
 *   An update that changes no such value (formatting only, or only transitive lockfile entries)
 *   gets only the line check.
 *
 * Known limit of a line-based check: a line the update adds that the owner's file has only inside
 * a comment (or a string) still counts as present, and a line the update removes that the owner
 * left only inside a comment counts as kept. The moderator reviews the version's diff either way.
 */

import { pnpmDirectDependencies } from './pnpm-lockfile';

/** The bytes as UTF-8 text, or `null` when they are not valid UTF-8. */
export function utf8TextOf(content: Buffer): string | null {
  const text = content.toString('utf8');
  return Buffer.from(text, 'utf8').equals(content) ? text : null;
}

/** Occurrences of each non-blank line (line endings normalised). */
function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

export type UpdatePathSides = {
  want: Buffer | null;
  base: Buffer | null;
  have: Buffer | null;
};

export function pathHoldsUpdate({ want, base, have }: UpdatePathSides): boolean {
  if (want === null) return have === null;
  if (have === null) return false;
  if (have.equals(want)) return true;
  const w = utf8TextOf(want);
  const h = utf8TextOf(have);
  const b = base === null ? '' : utf8TextOf(base);
  if (w === null || h === null || b === null) return false;
  const wantCounts = lineCounts(w);
  const baseCounts = lineCounts(b);
  const haveCounts = lineCounts(h);
  const count = (m: Map<string, number>, line: string) => m.get(line) ?? 0;
  let changed = false;
  for (const line of new Set([...wantCounts.keys(), ...baseCounts.keys()])) {
    const inWant = count(wantCounts, line);
    const inBase = count(baseCounts, line);
    if (inWant === inBase) continue;
    changed = true;
    const inHave = count(haveCounts, line);
    // Added: every base copy plus every added one. Removed: no more than the update left.
    if (inWant > inBase ? inHave < inWant : inHave > inWant) return false;
  }
  // Nothing added or removed (a reorder, blank lines, line endings): only the exact bytes hold it,
  // and they were checked above.
  return changed;
}

// ---------------------------------------------------------------------------
// Dependency files: package.json and pnpm-lock.yaml
// ---------------------------------------------------------------------------

const DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON equality, object key order ignored. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
}

type JsonChange = { path: string[]; want: unknown };

/**
 * Each value `want` changes from `base` (`want: undefined` for a removed key), compared key by key
 * down through objects. An object added or removed whole is its keys added or removed, so an update
 * that drops a whole `optionalDependencies` requires each of its packages gone, not the key.
 */
function jsonChanges(base: unknown, want: unknown, path: string[], out: JsonChange[]): void {
  if (jsonEqual(base, want)) return;
  const objectOrNone = (v: unknown) => v === undefined || isPlainObject(v);
  if ((isPlainObject(want) || isPlainObject(base)) && objectOrNone(want) && objectOrNone(base)) {
    const from = (base ?? {}) as Record<string, unknown>;
    const to = (want ?? {}) as Record<string, unknown>;
    const own = (o: Record<string, unknown>, key: string) =>
      Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      jsonChanges(own(from, key), own(to, key), [...path, key], out);
    }
    return;
  }
  out.push({ path, want });
}

function jsonAt(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

const shown = (v: unknown) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

function describeJsonGap(file: string, path: string[], want: unknown, have: unknown): string {
  const what =
    path.length === 2 && DEPENDENCY_SECTIONS.has(path[0]!)
      ? `${path[1]} (${path[0]})`
      : path.length
      ? path.join('.')
      : 'the file';
  if (want === undefined) return `${file}: ${what} must be removed, bundle has ${shown(have)}`;
  const has = have === undefined ? 'bundle has none' : `bundle has ${shown(have)}`;
  return `${file}: ${what} must be ${shown(want)}, ${has}`;
}

/** Every side as JSON; `null` when one does not parse (a missing base is `undefined`). */
function parseJsonSides(sides: TextSides): { want: unknown; base: unknown; have: unknown } | null {
  try {
    return {
      want: JSON.parse(sides.want),
      base: sides.base === null ? undefined : JSON.parse(sides.base),
      have: JSON.parse(sides.have),
    };
  } catch {
    return null;
  }
}

function packageJsonGaps(file: string, sides: TextSides): string[] | null {
  const parsed = parseJsonSides(sides);
  if (!parsed) return null;
  const changes: JsonChange[] = [];
  jsonChanges(parsed.base, parsed.want, [], changes);
  if (!changes.length) return null;
  const gaps: string[] = [];
  for (const { path, want } of changes) {
    const have = jsonAt(parsed.have, path);
    if (!jsonEqual(have, want)) gaps.push(describeJsonGap(file, path, want, have));
  }
  return gaps;
}

function pnpmLockGaps(file: string, sides: TextSides): string[] | null {
  let want: Map<string, Map<string, string>>;
  let base: Map<string, Map<string, string>>;
  let have: Map<string, Map<string, string>>;
  try {
    want = pnpmDirectDependencies(sides.want);
    base = sides.base === null ? new Map() : pnpmDirectDependencies(sides.base);
    have = pnpmDirectDependencies(sides.have);
  } catch {
    return null;
  }
  let changed = false;
  const gaps: string[] = [];
  for (const importer of new Set([...base.keys(), ...want.keys()])) {
    const w = want.get(importer) ?? new Map<string, string>();
    const b = base.get(importer) ?? new Map<string, string>();
    const h = have.get(importer) ?? new Map<string, string>();
    const where = importer === '.' ? file : `${file} (importer ${importer})`;
    for (const name of new Set([...b.keys(), ...w.keys()])) {
      const wv = w.get(name);
      if (wv === b.get(name)) continue;
      changed = true;
      const hv = h.get(name);
      if (hv === wv) continue;
      if (wv === undefined) gaps.push(`${where}: ${name} must be removed, bundle resolves ${hv}`);
      else
        gaps.push(
          `${where}: ${name} must resolve to ${wv}, ${
            hv === undefined ? 'bundle has none' : `bundle has ${hv}`
          }`
        );
    }
  }
  return changed ? gaps : null;
}

type TextSides = { want: string; base: string | null; have: string };

/**
 * A dependency file's missing changes: `[]` when the tree holds every one, `null` when this
 * reading does not apply (not a dependency file, a side that is not UTF-8 or does not parse, or
 * an update that changes no dependency value).
 */
function dependencyGaps(path: string, { want, base, have }: UpdatePathSides): string[] | null {
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (file !== 'package.json' && file !== 'pnpm-lock.yaml') return null;
  if (want === null || have === null) return null;
  // Every leading BOM is dropped, as the CLI and the SDK-floor check do.
  const text = (buf: Buffer) => utf8TextOf(buf)?.replace(/^(?:\uFEFF)+/, '') ?? null;
  const w = text(want);
  const h = text(have);
  const b = base === null ? null : text(base);
  if (w === null || h === null || (base !== null && b === null)) return null;
  const sides = { want: w, base: b, have: h };
  return file === 'package.json' ? packageJsonGaps(path, sides) : pnpmLockGaps(path, sides);
}

/**
 * Whether the tree holds the update at `path`, and if not, what it lacks: `null` when it holds;
 * otherwise the specific dependency changes it lacks (named, for a `package.json` or
 * `pnpm-lock.yaml` that parsed), or `[]` when only the path can be named.
 */
export function updatePathGaps(path: string, sides: UpdatePathSides): string[] | null {
  if (pathHoldsUpdate(sides)) return null;
  const gaps = dependencyGaps(path, sides);
  if (gaps === null) return [];
  return gaps.length ? gaps : null;
}

export type MissingUpdatePath = {
  path: string;
  /** The dependency changes this path lacks (see {@link updatePathGaps}); empty when unnamed. */
  changes: string[];
};

/**
 * The paths of an update the tree does not hold, in the record's order, each with the dependency
 * changes it lacks. `sides` reads one path's three sides; it is asked once per path, in order.
 */
export async function missingUpdateChanges(
  paths: ReadonlyArray<{ path: string }>,
  sides: (path: string) => Promise<UpdatePathSides>
): Promise<MissingUpdatePath[]> {
  const missing: MissingUpdatePath[] = [];
  for (const { path } of paths) {
    const gaps = updatePathGaps(path, await sides(path));
    if (gaps !== null) missing.push({ path, changes: gaps });
  }
  return missing;
}

/** {@link missingUpdateChanges}, the paths only. */
export async function missingUpdatePaths(
  paths: ReadonlyArray<{ path: string }>,
  sides: (path: string) => Promise<UpdatePathSides>
): Promise<string[]> {
  return (await missingUpdateChanges(paths, sides)).map((m) => m.path);
}
