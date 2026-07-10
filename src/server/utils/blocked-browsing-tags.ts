export function stripBlockedTagIds(
  tagIds: number[] | undefined,
  blockedIds: Iterable<number>
): { tagIds?: number[]; emptyResult: boolean } {
  if (!tagIds?.length) return { tagIds, emptyResult: false };
  const blocked = blockedIds instanceof Set ? blockedIds : new Set(blockedIds);
  const filtered = tagIds.filter((id) => !blocked.has(id));
  return { tagIds: filtered, emptyResult: filtered.length === 0 };
}

export function isBlockedTagName(
  name: string | undefined,
  blockedNames: Iterable<string>
): boolean {
  if (!name) return false;
  const blocked = blockedNames instanceof Set ? blockedNames : new Set(blockedNames);
  return blocked.has(name.toLowerCase());
}
