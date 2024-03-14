import { useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils';
import { isDefined, paired } from '~/utils/type-guards';

export function useApplyHiddenPreferences<
  T extends keyof BaseDataTypeMap,
  TData extends BaseDataTypeMap[T]
>({
  type,
  data,
  showHidden,
  disabled,
  isLoading,
}: {
  type: T;
  data?: TData;
  showHidden?: boolean;
  disabled?: boolean;
  isLoading?: boolean;
}) {
  const currentUser = useCurrentUser();
  const isModerator = !!currentUser?.isModerator;
  const [previous, setPrevious] = useState<any[]>([]);
  const browsingLevel = useBrowsingLevelDebounced();

  const { hiddenModels, hiddenImages, hiddenTags, hiddenUsers, hiddenLoading, moderatedTags } =
    useHiddenPreferencesContext();

  const items = useMemo(
    () => {
      if (disabled) return data ?? [];
      if (hiddenLoading || !data) return [];
      const { key, value } = paired<BaseDataTypeMap>(type, data);

      function filterPreferences() {
        switch (key) {
          case 'models':
            return value
              .filter((model) => {
                const userId = model.user.id;
                const isOwner = userId === currentUser?.id;
                if ((isOwner || isModerator) && model.nsfwLevel === 0) return true;
                if (!Flags.intersects(model.nsfwLevel, browsingLevel)) return false;
                if (userId && hiddenUsers.get(userId)) return false;
                if (hiddenModels.get(model.id) && !showHidden) return false;
                for (const tag of model.tags ?? []) if (hiddenTags.get(tag)) return false;
                return true;
              })
              .map(({ images, ...x }) => {
                const filteredImages =
                  images?.filter((i) => {
                    const userId = i.userId;
                    const isOwner = userId && userId === currentUser?.id;
                    if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
                    if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
                    if (hiddenImages.get(i.id)) return false;
                    for (const tag of i.tags ?? []) if (hiddenTags.get(tag)) return false;
                    return true;
                  }) ?? [];
                return filteredImages.length
                  ? {
                      ...x,
                      images: filteredImages,
                    }
                  : null;
              })
              .filter(isDefined);
          case 'images':
            return value.filter((image) => {
              const userId = image.userId ?? image.user?.id;
              const isOwner = userId && userId === currentUser?.id;
              if ((isOwner || isModerator) && image.nsfwLevel === 0) return true;
              if (!Flags.intersects(image.nsfwLevel, browsingLevel)) return false;
              if (userId && hiddenUsers.get(userId)) return false;
              if (hiddenImages.get(image.id) && !showHidden) return false;
              for (const tag of image.tagIds ?? []) if (hiddenTags.get(tag)) return false;
              return true;
            });
          case 'articles':
            return value.filter((article) => {
              const userId = article.user.id;
              const isOwner = userId === currentUser?.id;
              if ((isOwner || isModerator) && article.nsfwLevel === 0) return true;
              if (!Flags.intersects(article.nsfwLevel, browsingLevel)) return false;
              if (article.user && hiddenUsers.get(article.user.id)) return false;
              for (const tag of article.tags ?? []) if (hiddenTags.get(tag.id)) return false;
              if (article.coverImage) {
                if (hiddenImages.get(article.coverImage.id)) return false;
                for (const tag of article.coverImage.tags) if (hiddenTags.get(tag)) return false;
              }
              return true;
            });
          case 'users':
            return value.filter((user) => {
              if (user.id === currentUser?.id) return true;
              if (hiddenUsers.get(user.id)) return false;
              return true;
            });
          case 'collections':
            return value
              .filter((collection) => {
                const userId = collection.userId ?? collection.user?.id;
                const isOwner = userId && userId === currentUser?.id;
                if ((isOwner || isModerator) && collection.nsfwLevel === 0) return true;
                if (!Flags.intersects(collection.nsfwLevel, browsingLevel)) return false;
                if (userId && hiddenUsers.get(userId)) return false;
                if (collection.image) {
                  if (hiddenImages.get(collection.image.id)) return false;
                  for (const tag of collection.image.tagIds ?? [])
                    if (hiddenTags.get(tag)) return false;
                }
                return true;
              })
              .map(({ images, ...x }) => {
                const filteredImages =
                  images?.filter((i) => {
                    const userId = i.userId;
                    const isOwner = userId === currentUser?.id;
                    if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
                    if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
                    if (hiddenImages.get(i.id)) return false;
                    for (const tag of i.tagIds ?? []) if (hiddenTags.get(tag)) return false;
                    return true;
                  }) ?? [];
                return filteredImages.length
                  ? {
                      ...x,
                      images: filteredImages,
                    }
                  : null;
              })
              .filter(isDefined);
          case 'bounties':
            return value
              .filter((bounty) => {
                const userId = bounty.user.id;
                const isOwner = userId === currentUser?.id;
                if ((isOwner || isModerator) && bounty.nsfwLevel === 0) return true;
                if (!Flags.intersects(bounty.nsfwLevel, browsingLevel)) return false;
                if (hiddenUsers.get(bounty.user.id)) return false;
                for (const image of bounty.images ?? [])
                  if (hiddenImages.get(image.id)) return false;
                for (const tag of bounty.tags ?? []) if (hiddenTags.get(tag)) return false;
                return true;
              })
              .map(({ images, ...x }) => {
                const filteredImages = images?.filter((i) => {
                  const userId = i.userId;
                  const isOwner = userId === currentUser?.id;
                  if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
                  if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
                  if (hiddenImages.get(i.id)) return false;
                  for (const tag of i.tagIds ?? []) if (hiddenTags.get(tag)) return false;
                  return true;
                });
                return filteredImages.length
                  ? {
                      ...x,
                      images: filteredImages,
                    }
                  : null;
              })
              .filter(isDefined);
          case 'posts':
            return value
              .filter((post) => {
                const userId = post.userId ?? post.user?.id;
                const isOwner = userId && userId === currentUser?.id;
                if ((isOwner || isModerator) && post.nsfwLevel === 0) return true;
                if (!Flags.intersects(post.nsfwLevel, browsingLevel)) return false;
                if (userId && hiddenUsers.get(userId)) return false;
                return true;
              })
              .map((post) => {
                const images = post.images;
                if (!images) return post;
                const filteredImages = images.filter((image) => {
                  const userId = image.userId ?? image.user?.id;
                  const isOwner = userId === currentUser?.id;
                  if ((isOwner || isModerator) && image.nsfwLevel === 0) return true;
                  if (!Flags.intersects(image.nsfwLevel, browsingLevel)) return false;
                  if (hiddenImages.get(image.id)) return false;
                  for (const tag of image.tagIds ?? []) if (hiddenTags.get(tag)) return false;
                  return true;
                });
                return filteredImages.length ? { ...post, images: filteredImages } : null;
              })
              .filter(isDefined);
          case 'tags': {
            const moderatedTagIds = moderatedTags
              .filter((x) => !!x.nsfwLevel && Flags.intersects(x.nsfwLevel, browsingLevel))
              .map((x) => x.id);
            return value.filter((tag) => {
              if (hiddenTags.get(tag.id)) return false;
              if (
                !!tag.nsfwLevel &&
                tag.nsfwLevel > NsfwLevel.PG13 &&
                !moderatedTagIds.includes(tag.id)
              )
                return false;
              return true;
            });
          }
          default:
            throw new Error('unhandled hidden user preferences filter type');
        }
      }

      const filtered = filterPreferences();
      return filtered;
    },
    // eslint-disable-next-line
  [
      data,
      hiddenModels,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      hiddenLoading,
      disabled,
      browsingLevel,
    ]
  );

  useEffect(() => setPrevious(items), [data]);
  // const _items = useMemo(
  //   () => (isLoading ? previous : items) as TData,
  //   [isLoading, items, previous]
  // );
  const hiddenCount = !!data?.length ? data.length - items.length : 0;

  return {
    loadingPreferences: hiddenLoading,
    items: (isLoading ? previous : items) as TData,
    hiddenCount,
  };
}

type BaseImage = {
  id: number;
  userId?: number | null;
  user?: { id: number };
  tagIds?: number[];
  nsfwLevel: number;
};

type BaseModel = {
  id: number;
  user: { id: number };
  images: { id: number; tags?: number[]; nsfwLevel: number; userId?: number }[];
  tags?: number[];
  nsfwLevel: number;
  nsfw?: boolean;
};

type BaseArticle = {
  id: number;
  user: { id: number };
  nsfwLevel: number;
  tags?: {
    id: number;
  }[];
  coverImage?: {
    id: number;
    tags: number[];
    nsfwLevel: number;
  };
};

type BaseUser = {
  id: number;
};

type BaseCollection = {
  id: number;
  userId?: number | null;
  user?: { id: number };
  nsfwLevel: number;
  image: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId: number;
  } | null;
  images: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId: number;
  }[];
};

type BaseBounty = {
  id: number;
  user: { id: number };
  tags?: number[];
  nsfwLevel: number;
  nsfw?: boolean;
  images: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId: number;
  }[];
};

type BasePost = {
  // id: number;
  userId?: number;
  user?: { id: number };
  nsfwLevel: number;
  images?: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId?: number;
    user?: { id: number };
  }[];
};

type BaseTag = {
  id: number;
  nsfwLevel?: number;
};

export type BaseDataTypeMap = {
  images: BaseImage[];
  models: BaseModel[];
  articles: BaseArticle[];
  users: BaseUser[];
  collections: BaseCollection[];
  bounties: BaseBounty[];
  posts: BasePost[];
  tags: BaseTag[];
};
