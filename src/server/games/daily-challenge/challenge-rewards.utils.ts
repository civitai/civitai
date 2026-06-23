export function selectPayableUsers(qualifierIds: number[], excludeUserIds: number[]): number[] {
  const exclude = new Set(excludeUserIds);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of qualifierIds) {
    if (exclude.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
