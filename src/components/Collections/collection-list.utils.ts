import { CollectionMode } from '~/shared/utils/prisma/enums';

export type CollectionListView = 'default' | 'compact';
export type CollectionSort = 'name-asc' | 'name-desc' | 'recently-added' | 'recently-updated';
export type CollectionMembership = 'bookmarks' | 'owned' | 'shared' | 'following';

type PermissionFlags = { isCollaborator?: boolean; manage?: boolean } | undefined;
type SectionCollection = { isOwner: boolean; mode?: CollectionMode | null };

export const SORT_OPTIONS: { value: CollectionSort; label: string }[] = [
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'recently-added', label: 'Recently added' },
  { value: 'recently-updated', label: 'Recently updated' },
];

// `isCollaborator` is the server's "elevated beyond the collection's free grant" test
// (collection.service.ts). CollectionContributor also stores follow rows, so a row alone
// never means shared — only that flag does.
// Bookmark collections are owned by the user, so they must be picked off before the ownership
// branch or they fall in with the collections the user made themselves. Still gated on ownership:
// someone else's Bookmark collection is not one of yours.
export function getMembership(
  collection: SectionCollection,
  permissions: PermissionFlags
): CollectionMembership {
  if (collection.mode === CollectionMode.Bookmark && collection.isOwner) return 'bookmarks';
  if (collection.isOwner) return 'owned';
  return permissions?.isCollaborator ? 'shared' : 'following';
}

const SECTION_LABELS: Record<CollectionMembership, string> = {
  bookmarks: 'Likes & bookmarks',
  owned: 'Owned',
  shared: 'Shared with me',
  following: 'Following',
};

// Every row lands in exactly one section, so nothing can be filtered out of the rendered set.
// `permissions` is empty whenever the collaborative flag is off or its query hasn't resolved,
// which classifies non-owned rows as following rather than dropping them.
export function buildCollectionSections<T extends { id: number } & SectionCollection>(
  collections: T[],
  permissions: ReadonlyMap<number, PermissionFlags>
): { key: CollectionMembership; label: string; rows: T[] }[] {
  const rows: Record<CollectionMembership, T[]> = {
    bookmarks: [],
    owned: [],
    shared: [],
    following: [],
  };
  for (const collection of collections) {
    rows[getMembership(collection, permissions.get(collection.id))].push(collection);
  }

  return (['bookmarks', 'owned', 'shared', 'following'] as const).map((key) => ({
    key,
    label: SECTION_LABELS[key],
    rows: rows[key],
  }));
}

export function roleLabelFor(permissions: PermissionFlags): string | null {
  if (!permissions?.isCollaborator) return null;
  return permissions.manage ? 'Manager' : 'Contributor';
}

export function sortCollections<
  T extends { name: string; createdAt?: Date | string | null; updatedAt?: Date | string | null }
>(collections: T[], sort: CollectionSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // `createdAt`/`updatedAt` are nullable on Collection, and rows predating the columns have
  // neither. Sort those last rather than letting NaN scramble the comparator.
  const time = (value: Date | string | null | undefined) =>
    value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
  const byNewest = (a: T, b: T, key: 'createdAt' | 'updatedAt') => {
    const diff = time(b[key]) - time(a[key]);
    return Number.isNaN(diff) || diff === 0 ? byName(a, b) : diff;
  };

  return [...collections].sort((a, b) => {
    switch (sort) {
      case 'name-desc':
        return byName(b, a);
      case 'recently-added':
        return byNewest(a, b, 'createdAt');
      case 'recently-updated':
        return byNewest(a, b, 'updatedAt');
      default:
        return byName(a, b);
    }
  });
}
