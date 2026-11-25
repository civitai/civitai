import { useMemo } from 'react';
import { useQueryArticles } from '~/components/Article/article.utils';
import { useQueryImages } from '~/components/Image/image.utils';
import { useQueryModels } from '~/components/Model/model.utils';
import { ArticleSort, ImageSort, ModelSort } from '~/server/common/enums';
import type { FolderItemRef } from '~/server/services/profile-folder-reads.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

export const folderUrl = (username: string, folderId?: number) =>
  `/user/${username}/folders${folderId ? `/${folderId}` : ''}`;

export const folderItemKey = (ref: FolderItemRef) => `${ref.type}-${ref.id}`;

const idsOf = (refs: FolderItemRef[], type: FolderItemRef['type']) =>
  refs.filter((ref) => ref.type === type).map((ref) => ref.id);

/**
 * A folder's items by id, through the feeds that apply the viewer's browsing level and hidden
 * preferences, in the order given. An item a feed does not return (hidden, deleted, above the
 * viewer's level) is left out.
 */
export function useFolderItems(
  refs: FolderItemRef[],
  { userId, username, enabled = true }: { userId: number; username: string; enabled?: boolean }
) {
  const imageIds = idsOf(refs, 'Image');
  const modelIds = idsOf(refs, 'Model');
  const articleIds = idsOf(refs, 'Article');

  const images = useQueryImages(
    {
      ids: imageIds,
      userId,
      publishedOnly: true,
      period: MetricTimeframe.AllTime,
      sort: ImageSort.Newest,
      limit: Math.max(imageIds.length, 1),
      withMeta: false,
      include: ['profilePictures', 'cosmetics'],
      notPublished: false,
    },
    { keepPreviousData: true, enabled: enabled && imageIds.length > 0 }
  );
  const models = useQueryModels(
    {
      ids: modelIds,
      username,
      sort: ModelSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: Math.max(modelIds.length, 1),
    },
    { keepPreviousData: true, enabled: enabled && modelIds.length > 0 }
  );
  const articles = useQueryArticles(
    {
      ids: articleIds,
      username,
      sort: ArticleSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: Math.max(articleIds.length, 1),
    },
    { keepPreviousData: true, enabled: enabled && articleIds.length > 0 }
  );

  const imageRows = images.images;
  const modelRows = models.models;
  const articleRows = articles.articles;
  const items = useMemo(() => {
    const found = {
      Image: new Map(imageRows.map((image) => [image.id, image])),
      Model: new Map(modelRows.map((model) => [model.id, model])),
      Article: new Map(articleRows.map((article) => [article.id, article])),
    };
    const list: FolderItemOf<
      (typeof imageRows)[number],
      (typeof modelRows)[number],
      (typeof articleRows)[number]
    >[] = [];
    for (const ref of refs) {
      if (ref.type === 'Image') {
        const data = found.Image.get(ref.id);
        if (data) list.push({ type: 'Image', id: ref.id, data });
      } else if (ref.type === 'Model') {
        const data = found.Model.get(ref.id);
        if (data) list.push({ type: 'Model', id: ref.id, data });
      } else {
        const data = found.Article.get(ref.id);
        if (data) list.push({ type: 'Article', id: ref.id, data });
      }
    }
    return list;
  }, [refs, imageRows, modelRows, articleRows]);

  const isLoading =
    (imageIds.length > 0 && images.isLoading) ||
    (modelIds.length > 0 && models.isLoading) ||
    (articleIds.length > 0 && articles.isLoading);

  return { items, isLoading };
}

type FolderItemOf<I, M, A> =
  | { type: 'Image'; id: number; data: I }
  | { type: 'Model'; id: number; data: M }
  | { type: 'Article'; id: number; data: A };

export type FolderItem = ReturnType<typeof useFolderItems>['items'][number];

/** The picture that stands for an item on a thumbnail. */
export function folderItemCover(item: FolderItem) {
  if (item.type === 'Image') return item.data;
  if (item.type === 'Model') return item.data.images?.[0];
  return item.data.coverImage;
}
