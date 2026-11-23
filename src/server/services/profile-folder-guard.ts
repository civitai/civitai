import { uniq } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { mutedAccountRefusal } from '~/server/services/account-restriction.service';
import { isAccountMuted } from '~/server/services/account-standing.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { CollectionMode, CollectionType } from '~/shared/utils/prisma/enums';

export const folderItemTypes = [
  CollectionType.Model,
  CollectionType.Image,
  CollectionType.Article,
] as const;
export type FolderItemType = (typeof folderItemTypes)[number];

/** What a folder write needs from the caller's request: the flag and their mute state. */
export type FolderWriteAccess = {
  foldersEnabled: boolean;
  session: { muted?: boolean | null; mutedAt?: Date | null };
};

/**
 * Refuses a write that touches a profile folder unless the caller has `profileFolders`, is not
 * muted and, for adds, every item belongs to the folder's owner. Writes that touch no folder pass
 * untouched, so collections behave as before. A caller that passes no `access` cannot write
 * folders at all: only the collection procedures, which pass it, reach them.
 */
export async function assertFolderWriteAllowed({
  collectionIds,
  userId,
  access,
  items,
}: {
  collectionIds: number[];
  userId: number;
  access?: FolderWriteAccess;
  items?: { type: CollectionType; ids: number[] };
}) {
  const ids = uniq(collectionIds);
  if (!ids.length) return;

  // primary: a folder created moments ago must already be recognised as one.
  const folders = await dbWrite.collection.findMany({
    where: { id: { in: ids }, mode: CollectionMode.Folder },
    select: { id: true, userId: true },
  });
  if (!folders.length) return;

  if (!access?.foldersEnabled) throw throwAuthorizationError('Folders are not available');
  if (access.session.muted || (await isAccountMuted(userId, !!access.session.muted)))
    throw await mutedAccountRefusal(userId, { mutedAt: access.session.mutedAt });

  if (!items || !items.ids.length) return;
  if (!(folderItemTypes as readonly CollectionType[]).includes(items.type))
    throw throwBadRequestError('Folders hold models, images and articles');

  // No moderator exemption: a folder holds its owner's own work, whoever files it.
  const ownerIds = uniq(folders.map((folder) => folder.userId));
  if (ownerIds.length > 1) throw throwBadRequestError("Add to one owner's folders at a time");
  const owned = await countOwnedItems(items.type as FolderItemType, uniq(items.ids), ownerIds[0]);
  if (owned !== uniq(items.ids).length)
    throw throwAuthorizationError("A folder can only hold its owner's own content");
}

// An item posted or transferred moments ago is the one most likely being filed.
function countOwnedItems(type: FolderItemType, ids: number[], ownerId: number) {
  const where = { id: { in: ids }, userId: ownerId };
  switch (type) {
    case CollectionType.Model:
      // primary: checks the owner of what is about to be filed.
      return dbWrite.model.count({ where });
    case CollectionType.Image:
      // primary: checks the owner of what is about to be filed.
      return dbWrite.image.count({ where });
    case CollectionType.Article:
      // primary: checks the owner of what is about to be filed.
      return dbWrite.article.count({ where });
  }
}

/** Which of these collections are profile folders. */
export async function getFolderIds(collectionIds: number[]) {
  const ids = uniq(collectionIds);
  if (!ids.length) return new Set<number>();
  const folders = await dbRead.collection.findMany({
    where: { id: { in: ids }, mode: CollectionMode.Folder },
    select: { id: true },
  });
  return new Set(folders.map((folder) => folder.id));
}

/** True when every id is a folder: filing your own work is not someone collecting it. */
export async function onlyFolders(collectionIds: number[]) {
  const ids = uniq(collectionIds);
  if (!ids.length) return false;
  const folderIds = await getFolderIds(ids);
  return ids.every((id) => folderIds.has(id));
}
