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
 *   - the update deletes it, and the tree lacks it;
 *   - the tree's file is byte-for-byte the update's;
 *   - or the file was merged by hand (the owner's edits beside the update's): every side is UTF-8
 *     text and the tree's file has every non-blank line the update adds to its base. An update
 *     that adds no line (it only removes lines) holds when the tree's file differs from the base.
 * A file that is not text on some side must be exactly the update's.
 */

/** The bytes as UTF-8 text, or `null` when they are not valid UTF-8. */
export function utf8TextOf(content: Buffer): string | null {
  const text = content.toString('utf8');
  return Buffer.from(text, 'utf8').equals(content) ? text : null;
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
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
  const baseLines = new Set(linesOf(b));
  const added = linesOf(w).filter((line) => line.trim() !== '' && !baseLines.has(line));
  if (added.length === 0) return base === null || !have.equals(base);
  const haveLines = new Set(linesOf(h));
  return added.every((line) => haveLines.has(line));
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
