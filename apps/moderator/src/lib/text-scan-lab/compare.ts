/** The pair the compare view opens on: the version before the newest, and the newest. `versions` are newest first. */
export function defaultComparePair(
  versions: readonly { id: number }[]
): { from: number; to: number } | null {
  if (versions.length < 2) return null;
  return { from: versions[1].id, to: versions[0].id };
}
