import { sql } from 'kysely';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { profileFolderLimits } from '~/server/schema/profile-folders.schema';
import type { FolderItemType } from '~/server/services/profile-folder-guard';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import {
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
} from '~/shared/utils/prisma/enums';

export type FolderItemRef = { type: FolderItemType; id: number };
export type FolderCounts = { Model: number; Image: number; Article: number; total: number };

type ItemRow = {
  modelId: number | null;
  imageId: number | null;
  articleId: number | null;
};

const itemRef = (row: ItemRow): FolderItemRef | null =>
  row.modelId
    ? { type: CollectionType.Model as FolderItemType, id: row.modelId }
    : row.imageId
    ? { type: CollectionType.Image as FolderItemType, id: row.imageId }
    : row.articleId
    ? { type: CollectionType.Article as FolderItemType, id: row.articleId }
    : null;

const emptyCounts = (): FolderCounts => ({ Model: 0, Image: 0, Article: 0, total: 0 });

/**
 * Per folder: its item counts by type, and the items its card shows. The card shows the owner's
 * showcased items (oldest first); a folder with none shows its newest items instead.
 */
export async function getFolderSummaries(folderIds: number[], db = kyselyRead) {
  const summaries = new Map<number, { counts: FolderCounts; preview: FolderItemRef[] }>();
  if (!folderIds.length) return summaries;
  for (const id of folderIds) summaries.set(id, { counts: emptyCounts(), preview: [] });

  const [counts, preview] = await Promise.all([
    sql<{ collectionId: number; models: number; images: number; articles: number }>`
      SELECT "collectionId",
        count(*) FILTER (WHERE "modelId" IS NOT NULL)::int AS models,
        count(*) FILTER (WHERE "imageId" IS NOT NULL)::int AS images,
        count(*) FILTER (WHERE "articleId" IS NOT NULL)::int AS articles
      FROM "CollectionItem"
      WHERE "collectionId" IN (${sql.join(folderIds)}) AND status = 'ACCEPTED'
      GROUP BY "collectionId"
    `.execute(db),
    sql<ItemRow & { collectionId: number; showcasedAt: Date | null }>`
      SELECT "collectionId", "modelId", "imageId", "articleId", "showcasedAt"
      FROM (
        SELECT "collectionId", "modelId", "imageId", "articleId", "showcasedAt",
          row_number() OVER (
            PARTITION BY "collectionId"
            ORDER BY "showcasedAt" ASC NULLS LAST, id DESC
          ) AS rn
        FROM "CollectionItem"
        WHERE "collectionId" IN (${sql.join(folderIds)}) AND status = 'ACCEPTED'
          AND ("modelId" IS NOT NULL OR "imageId" IS NOT NULL OR "articleId" IS NOT NULL)
      ) ranked
      WHERE rn <= ${profileFolderLimits.showcase}
      ORDER BY "collectionId", rn
    `.execute(db),
  ]);

  for (const row of counts.rows) {
    const summary = summaries.get(row.collectionId);
    if (!summary) continue;
    summary.counts = {
      Model: Number(row.models),
      Image: Number(row.images),
      Article: Number(row.articles),
      total: Number(row.models) + Number(row.images) + Number(row.articles),
    };
  }
  // Rows come showcased first: once a folder has a showcased item, only those are its card.
  const hasShowcase = new Set<number>();
  for (const row of preview.rows) {
    const summary = summaries.get(row.collectionId);
    const ref = itemRef(row);
    if (!summary || !ref) continue;
    if (row.showcasedAt) hasShowcase.add(row.collectionId);
    else if (hasShowcase.has(row.collectionId)) continue;
    summary.preview.push(ref);
  }
  return summaries;
}

/**
 * One folder as this viewer may see it: the owner and moderators see every folder, visitors a
 * Public or Unlisted one (an Unlisted folder opens by link though no list shows it). Anything
 * else, including a collection that is not a folder or a folder of another profile, is not found.
 */
export async function getProfileFolder({
  folderId,
  userId,
  viewerId,
  isModerator,
}: {
  folderId: number;
  userId: number;
  viewerId?: number;
  isModerator?: boolean;
}) {
  const seesAll = viewerId === userId || !!isModerator;
  // primary: only for the owner, whose edit is read back at once.
  const folder = await (viewerId === userId ? kyselyWrite : kyselyRead)
    .selectFrom('Collection')
    .select(['id', 'name', 'description', 'read', 'userId'])
    .where('id', '=', folderId)
    .where('userId', '=', userId)
    .where('mode', '=', CollectionMode.Folder)
    .executeTakeFirst();
  const visible =
    !!folder &&
    (seesAll ||
      folder.read === CollectionReadConfiguration.Public ||
      folder.read === CollectionReadConfiguration.Unlisted);
  if (!folder || !visible) throw throwNotFoundError('Folder not found');

  const summary = (await getFolderSummaries([folder.id])).get(folder.id);
  return { ...folder, counts: summary?.counts ?? emptyCounts(), isOwner: viewerId === userId };
}

/** The owner's folder editor: every item with its collection item id, newest first. */
export async function getFolderItems({ folderId, userId }: { folderId: number; userId: number }) {
  // primary: the editor reads back its own adds and removes.
  const rows = await kyselyWrite
    .selectFrom('CollectionItem as ci')
    .innerJoin('Collection as c', 'c.id', 'ci.collectionId')
    .select(['ci.id', 'ci.modelId', 'ci.imageId', 'ci.articleId', 'ci.showcasedAt'])
    .where('ci.collectionId', '=', folderId)
    .where('c.userId', '=', userId)
    .where('c.mode', '=', CollectionMode.Folder)
    .where('ci.status', '=', 'ACCEPTED')
    .orderBy('ci.id', 'desc')
    .limit(profileFolderLimits.editorItems)
    .execute();
  return rows.flatMap((row) => {
    const ref = itemRef(row);
    return ref ? [{ ...ref, collectionItemId: row.id, showcased: !!row.showcasedAt }] : [];
  });
}
