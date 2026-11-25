import { uniq } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  FolderRowSchema,
  GetProfileFoldersInput,
  SetFolderRowsInput,
} from '~/server/schema/profile-folders.schema';
import { profileFolderLimits } from '~/server/schema/profile-folders.schema';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import type { FolderCounts, FolderItemRef } from '~/server/services/profile-folder-reads.service';
import { getFolderSummaries } from '~/server/services/profile-folder-reads.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
} from '~/server/utils/errorHandling';
import { CollectionMode, CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

/** Saves the caller's folder rows whole. Every folder in them must be one of the caller's. */
export async function setFolderRows({
  userId,
  rows,
  ifUnchangedFrom,
}: SetFolderRowsInput & { userId: number }) {
  await throwOnBlockedUserContent(
    rows.map(({ name }) => name),
    { surface: 'userProfile', entityType: 'UserProfile', entityId: userId, userId }
  );

  const folderIds = uniq(rows.flatMap((row) => row.folders.map((folder) => folder.id)));
  if (folderIds.length !== rows.flatMap((row) => row.folders).length)
    throw throwBadRequestError('A folder can sit in one row only');
  if (folderIds.length) {
    // primary: a folder created moments ago may already be placed.
    const owned = await dbWrite.collection.count({
      where: { id: { in: folderIds }, userId, mode: CollectionMode.Folder },
    });
    if (owned !== folderIds.length)
      throw throwAuthorizationError('Only your own folders go in rows');
  }

  await dbWrite.userProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { userId: true },
  });
  if (ifUnchangedFrom) {
    const { count } = await dbWrite.userProfile.updateMany({
      where: { userId, folderRows: { equals: ifUnchangedFrom } },
      data: { folderRows: rows },
    });
    if (!count) throw throwConflictError('Your folders changed while saving. Try again.');
  } else {
    await dbWrite.userProfile.update({ where: { userId }, data: { folderRows: rows } });
  }
  // Every save. The scan skips text it has already seen.
  queueScamScan({ entityType: 'UserProfile', entityId: userId });
  return rows;
}

export type ProfileFolder = {
  id: number;
  name: string;
  description: string | null;
  read: CollectionReadConfiguration;
  hidden: boolean;
  counts: FolderCounts;
  /** What its card shows: the showcased items, else the newest; hydrated through the gated feeds. */
  preview: FolderItemRef[];
};
export type ProfileFolderRow = { id: string | null; name: string; folders: ProfileFolder[] };

/**
 * A user's folders in their rows. Visitors get Public folders that are not hidden; Unlisted
 * folders open by link but are not listed. The owner and moderators get all of them. Folders in no
 * row come last, in an untitled row.
 */
export async function getProfileFolders(
  {
    userId,
    viewerId,
    isModerator,
  }: GetProfileFoldersInput & { viewerId?: number; isModerator?: boolean },
  loadSummaries = getFolderSummaries
) {
  const seesAll = viewerId === userId || !!isModerator;
  const [folders, profile] = await Promise.all([
    dbRead.collection.findMany({
      where: {
        userId,
        mode: CollectionMode.Folder,
        ...(seesAll ? {} : { read: CollectionReadConfiguration.Public }),
      },
      select: { id: true, name: true, description: true, read: true },
      orderBy: { createdAt: 'asc' },
      take: profileFolderLimits.folders,
    }),
    dbRead.userProfile.findUnique({ where: { userId }, select: { folderRows: true } }),
  ]);

  const summaries = await loadSummaries(folders.map((folder) => folder.id));

  const storedRows = (profile?.folderRows ?? []) as FolderRowSchema[];
  const hiddenIds = new Set(
    storedRows.flatMap((row) => row.folders.filter((f) => f.hidden).map((f) => f.id))
  );
  const byId = new Map(
    folders
      .map(
        (folder): ProfileFolder => ({
          ...folder,
          hidden: hiddenIds.has(folder.id),
          counts: summaries.get(folder.id)?.counts ?? { Model: 0, Image: 0, Article: 0, total: 0 },
          preview: summaries.get(folder.id)?.preview ?? [],
        })
      )
      .filter((folder) => seesAll || !folder.hidden)
      .map((folder) => [folder.id, folder])
  );

  const placed = new Set<number>();
  const rows: ProfileFolderRow[] = storedRows.map((row) => ({
    id: row.id,
    name: row.name,
    folders: row.folders.flatMap(({ id }) => {
      const folder = byId.get(id);
      if (!folder) return [];
      placed.add(id);
      return [folder];
    }),
  }));
  const unplaced = [...byId.values()].filter((folder) => !placed.has(folder.id));
  if (unplaced.length) rows.push({ id: null, name: '', folders: unplaced });

  return {
    rows: rows.filter((row) => row.folders.length || seesAll),
    // The owner's editor saves over exactly these, so a save over newer rows is refused.
    storedRows:
      viewerId === userId ? (profile?.folderRows as FolderRowSchema[] | null) ?? null : null,
  };
}
