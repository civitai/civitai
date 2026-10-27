export type Access = 'allow' | 'closed';

export function parseTesterIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? '').split(',')) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

export function decideAccess(
  user: { id: number; isModerator?: boolean },
  testerIds: ReadonlySet<number>
): Access {
  return user.isModerator === true || testerIds.has(user.id) ? 'allow' : 'closed';
}
