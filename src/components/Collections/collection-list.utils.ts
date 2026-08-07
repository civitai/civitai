export type CollectionListView = 'default' | 'compact';
export type CollectionSort = 'name-asc' | 'name-desc';
export type CollectionMembership = 'owned' | 'shared' | 'following';

type PermissionFlags = { isCollaborator?: boolean; manage?: boolean } | undefined;

// Name-only for now. `getAllUser` builds its rows from a raw SELECT that does not include
// `createdAt` (collection.service.ts:440), so date sorts have no backing column — adding one
// is a server change, not a UI change.
export const SORT_OPTIONS: { value: CollectionSort; label: string }[] = [
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
];

// `isCollaborator` is the server's "elevated beyond the collection's free grant" test
// (collection.service.ts). CollectionContributor also stores follow rows, so a row alone
// never means shared — only that flag does.
export function getMembership(
  collection: { isOwner: boolean },
  permissions: PermissionFlags
): CollectionMembership {
  if (collection.isOwner) return 'owned';
  return permissions?.isCollaborator ? 'shared' : 'following';
}

export function roleLabelFor(permissions: PermissionFlags): string | null {
  if (!permissions?.isCollaborator) return null;
  return permissions.manage ? 'Manager' : 'Contributor';
}

export function sortCollections<T extends { name: string }>(
  collections: T[],
  sort: CollectionSort
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...collections].sort((a, b) => (sort === 'name-asc' ? byName(a, b) : byName(b, a)));
}
