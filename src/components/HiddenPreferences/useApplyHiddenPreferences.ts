import { ImageIngestionStatus } from '@prisma/client';
import { useMemo } from 'react';
import { useHiddenPreferencesContext } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { isDefined } from '~/utils/type-guards';

export function useApplyHiddenPreferences<
  T extends keyof DataTypeMap,
  TData extends DataTypeMap[T]
>({
  type,
  data,
  showHidden,
  disabled,
}: {
  type: T;
  data?: TData;
  showHidden?: boolean;
  disabled?: boolean;
}) {
  const currentUser = useCurrentUser();
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const items = useMemo(() => {
    if (disabled) return data ?? [];
    if (loadingPreferences || !data) return [];
    const { key, value } = paired<DataTypeMap>(type, data);

    switch (key) {
      case 'models':
        return value
          .filter((model) => {
            if (model.user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW) return true;
            if (hiddenUsers.get(model.user.id)) return false;
            if (hiddenModels.get(model.id) && !showHidden) return false;
            for (const tag of model.tags ?? []) if (hiddenTags.get(tag)) return false;
            return true;
          })
          .map(({ images, ...x }) => {
            const filteredImages = images?.filter((i) => {
              if (hiddenImages.get(i.id)) return false;
              for (const tag of i.tags ?? []) if (hiddenTags.get(tag)) return false;
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
      case 'images':
        return value.filter((image) => {
          if (image.user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW) return true;
          if (image.ingestion !== ImageIngestionStatus.Scanned) return false;
          if (hiddenUsers.get(image.user.id)) return false;
          if (hiddenImages.get(image.id) && !showHidden) return false;
          for (const tag of image.tagIds ?? []) if (hiddenTags.get(tag)) return false;
          return true;
        });
      case 'articles':
        return value.filter((article) => {
          if (article.user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW) return true;
          if (hiddenUsers.get(article.user.id)) return false;
          for (const tag of article.tags ?? []) if (hiddenTags.get(tag.id)) return false;
          return true;
        });
      case 'users':
        return value.filter((user) => {
          if (user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW) return true;
          if (hiddenUsers.get(user.id)) return false;
          return true;
        });
      case 'collections':
        return value
          .filter((collection) => {
            if (collection.user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW)
              return true;
            if (collection.image) {
              if (hiddenImages.get(collection.image.id)) return false;
              for (const tag of collection.image.tagIds ?? [])
                if (hiddenTags.get(tag)) return false;
            }
            return true;
          })
          .map(({ images, ...x }) => {
            const filteredImages = images?.filter((i) => {
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
      case 'bounties':
        return value
          .filter((bounty) => {
            if (bounty.user.id === currentUser?.id && browsingMode !== BrowsingMode.SFW)
              return true;
            for (const image of bounty.images ?? []) if (hiddenImages.get(image.id)) return false;
            for (const tag of bounty.tags ?? []) if (hiddenTags.get(tag)) return false;
            return true;
          })
          .map(({ images, ...x }) => {
            const filteredImages = images?.filter((i) => {
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
      default:
        throw new Error('unhandled hidden user preferences filter type');
    }
  }, [
    currentUser?.id,
    data,
    type,
    hiddenModels,
    hiddenImages,
    hiddenTags,
    hiddenUsers,
    loadingPreferences,
    browsingMode,
    showHidden,
    disabled,
  ]);

  return {
    loadingPreferences,
    items: items as TData,
    hiddenCount: !!data?.length ? data.length - items.length : 0,
  };
}

type BaseImage = {
  id: number;
  user: { id: number };
  tagIds?: number[];
  ingestion?: ImageIngestionStatus;
};

type BaseModel = {
  id: number;
  user: { id: number };
  images: { id: number; tags?: number[] }[];
  tags?: number[];
};

type BaseArticle = {
  id: number;
  user: {
    id: number;
  };
  tags?: {
    id: number;
  }[];
};

type BaseUser = {
  id: number;
};

type BaseCollection = {
  id: number;
  user: {
    id: number;
  };
  image: {
    id: number;
    tagIds?: number[];
  } | null;
  images: {
    id: number;
    tagIds?: number[];
  }[];
};

type BaseBounty = {
  id: number;
  user: {
    id: number;
  };
  tags?: number[];
  images: {
    id: number;
    tagIds?: number[];
  }[];
};

type DataTypeMap = {
  images: BaseImage[];
  models: BaseModel[];
  articles: BaseArticle[];
  users: BaseUser[];
  collections: BaseCollection[];
  bounties: BaseBounty[];
};

type Boxed<Mapping> = { [K in keyof Mapping]: { key: K; value: Mapping[K] } }[keyof Mapping];
function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
  return { key, value } as Boxed<Mapping>;
}
