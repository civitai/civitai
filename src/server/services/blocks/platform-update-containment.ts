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
 * Known limit of a line-based check: a line the update adds that the owner's file has only inside
 * a comment (or a string) still counts as present, and a line the update removes that the owner
 * left only inside a comment counts as kept. The moderator reviews the version's diff either way.
 */

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

/**
 * The paths of an update the tree does not hold, in the record's order. `sides` reads one path's
 * three sides; it is asked once per path, in order.
 */
export async function missingUpdatePaths(
  paths: ReadonlyArray<{ path: string }>,
  sides: (path: string) => Promise<UpdatePathSides>
): Promise<string[]> {
  const missing: string[] = [];
  for (const { path } of paths) {
    if (!pathHoldsUpdate(await sides(path))) missing.push(path);
  }
  return missing;
}
