/** The pair the compare view opens on: the version before the newest, and the newest. `versions` are newest first. */
export function defaultComparePair(
  versions: readonly { id: number }[]
): { from: number; to: number } | null {
  if (versions.length < 2) return null;
  return { from: versions[1].id, to: versions[0].id };
}

/** The pair the user picked, or the default pair when either picked id is no longer among `versions`. */
export function resolvePair(
  picked: { from: number; to: number } | null,
  versions: readonly { id: number }[]
): { from: number; to: number } | null {
  if (
    picked &&
    versions.some((v) => v.id === picked.from) &&
    versions.some((v) => v.id === picked.to)
  )
    return picked;
  return defaultComparePair(versions);
}
