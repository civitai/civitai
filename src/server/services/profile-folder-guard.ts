import { uniq } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { mutedAccountRefusal } from '~/server/services/account-restriction.service';
import { isAccountMuted } from '~/server/services/account-standing.service';
import { ownsAllContent } from '~/server/services/owned-content';
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

type CollectionRow = { id: number; mode: CollectionMode | null; userId: number };

/**
 * Refuses a write that touches a profile folder unless the caller has `profileFolders`, is not
 * muted and, for adds, every item belongs to the folder's owner. Writes that touch no folder pass
 * untouched, so collections behave as before. A caller that passes no `access` cannot write
 * folders at all: only the collection procedures, which pass it, reach them.
 *
 * Pass `collections` when the caller already holds the rows; a collection's mode never changes
 * after it is created, so a replica row answers this as well as the primary.
 */
export async function assertFolderWriteAllowed({
  collectionIds,
  collections,
  userId,
  access,
  items,
}: {
  collectionIds: number[];
  collections?: CollectionRow[];
  userId: number;
  access?: FolderWriteAccess;
  items?: { type: CollectionType; ids: number[] };
}) {
  const ids = uniq(collectionIds);
  if (!ids.length) return;

  const folders = collections
    ? collections.filter((c) => ids.includes(c.id) && c.mode === CollectionMode.Folder)
    : await findFolders(ids);
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
  const owned = await ownsAllContent({
    ownerId: ownerIds[0],
    modelIds: items.type === CollectionType.Model ? items.ids : [],
    imageIds: items.type === CollectionType.Image ? items.ids : [],
    articleIds: items.type === CollectionType.Article ? items.ids : [],
  });
  if (!owned) throw throwAuthorizationError("A folder can only hold its owner's own content");
}

function findFolders(ids: number[]) {
  // primary: a folder created moments ago must already be recognised as one.
  return dbWrite.collection.findMany({
    where: { id: { in: ids }, mode: CollectionMode.Folder },
    select: { id: true, mode: true, userId: true },
  });
}

/** True when every id is a folder: filing your own work is not someone collecting it. */
export async function onlyFolders(collectionIds: number[]) {
  const ids = uniq(collectionIds);
  if (!ids.length) return false;
  const folderIds = new Set((await findFolders(ids)).map((folder) => folder.id));
  return ids.every((id) => folderIds.has(id));
}
