import { useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NsfwLevel } from '~/server/common/enums';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { getBlockedNsfwWords, hasNsfwWords } from '~/utils/metadata/audit-base';
import { isDefined, paired } from '~/utils/type-guards';

export function useApplyHiddenPreferences<
  T extends keyof BaseDataTypeMap,
  TData extends BaseDataTypeMap[T]
>({
  type,
  data,
  showHidden,
  showImageless,
  disabled,
  isRefetching,
  hiddenImages = [],
  hiddenUsers = [],
  hiddenTags = [],
  browsingLevel: browsingLevelOverride,
  allowLowerLevels,
}: {
  type: T;
  data?: TData;
  showHidden?: boolean;
  showImageless?: boolean;
  disabled?: boolean;
  isRefetching?: boolean;
  hiddenImages?: number[];
  hiddenUsers?: number[];
  hiddenTags?: number[];
  browsingLevel?: number;
  allowLowerLevels?: boolean;
}) {
  const currentUser = useCurrentUser();
  const [previous, setPrevious] = useState<any[]>([]);
  const systemBrowsingLevel = useBrowsingLevelDebounced();
  const browsingLevel = browsingLevelOverride ?? systemBrowsingLevel;
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const { canViewNsfw } = useFeatureFlags();

  const hiddenPreferences = useHiddenPreferencesContext();

  // We need to stringify the hidden preferences to trigger a re-render when they change.
  const stringified = JSON.stringify([...hiddenImages, ...hiddenUsers, ...hiddenTags]);
  const { items, hidden } = useMemo(() => {
    const preferences = { ...hiddenPreferences };
    if (hiddenImages.length > 0)
      preferences.hiddenImages = new Map([
        ...preferences.hiddenImages,
        ...hiddenImages.map((id): [number, boolean] => [id, true]),
      ]);
    if (hiddenUsers.length > 0)
      preferences.hiddenUsers = new Map([
        ...preferences.hiddenUsers,
        ...hiddenUsers.map((id): [number, boolean] => [id, true]),
      ]);
    if (hiddenTags.length > 0) {
      preferences.hiddenTags = new Map([
        ...preferences.hiddenTags,
        ...hiddenTags.map((id): [number, boolean] => [id, true]),
      ]);
    }

    const { items, hidden } = filterPreferences({
      type,
      data,
      showHidden,
      showImageless,
      disabled,
      browsingLevel,
      hiddenPreferences: preferences,
      currentUser,
      allowLowerLevels,
      canViewNsfw,
      poiDisabled: browsingSettingsAddons.settings.disablePoi,
      minorDisabled: browsingSettingsAddons.settings.disableMinor,
    });

    return {
      items,
      hidden,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hiddenPreferences, stringified, showHidden, disabled, browsingLevel]);

  useEffect(() => setPrevious(items), [items]);

  // We will not be counting `noImages` because the user can't do anything about these.
  const hiddenCount =
    hidden.browsingLevel + hidden.models + hidden.images + hidden.tags + hidden.users;

  return {
    loadingPreferences: hiddenPreferences.hiddenLoading,
    items: (isRefetching ? previous : items) as TData,
    hiddenCount,
  };
}

type FilterPreferencesProps<TKey, TData> = {
  type: TKey;
  data?: TData;
  hiddenPreferences: HiddenPreferencesState;
  browsingLevel: number;
  showHidden?: boolean;
  showImageless?: boolean;
  disabled?: boolean;
  currentUser: ReturnType<typeof useCurrentUser>;
  allowLowerLevels?: boolean;
  canViewNsfw: boolean;
  poiDisabled?: boolean;
  minorDisabled?: boolean;
};

function filterPreferences<
  TKey extends keyof BaseDataTypeMap,
  TData extends BaseDataTypeMap[TKey]
>({
  type,
  data,
  hiddenPreferences,
  browsingLevel,
  showHidden,
  showImageless,
  disabled,
  currentUser,
  allowLowerLevels,
  canViewNsfw,
  poiDisabled,
  minorDisabled,
}: FilterPreferencesProps<TKey, TData>) {
  const hidden = {
    unprocessed: 0,
    browsingLevel: 0,
    models: 0,
    images: 0,
    tags: 0,
    users: 0,
    noImages: 0,
    poi: 0,
    minor: 0,
  };

  if (!data || hiddenPreferences.hiddenLoading)
    return {
      items: [],
      hidden,
    };

  if (disabled) {
    hidden.unprocessed = data.length;
    return {
      items: data,
      hidden,
    };
  }

  const isModerator = !!currentUser?.isModerator;
  const { key, value } = paired<BaseDataTypeMap>(type, data);
  const { hiddenModels, hiddenImages, hiddenTags, hiddenUsers, moderatedTags, systemHiddenTags } =
    hiddenPreferences;
  const maxSelectedLevel = Math.max(...parseBitwiseBrowsingLevel(browsingLevel));
  const maxBrowsingLevel = Flags.maxValue(browsingLevel);

  switch (key) {
    case 'models':
      const models = value
        .filter((model) => {
          const userId = model.user.id;
          const isOwner = userId === currentUser?.id;
          if (!canViewNsfw && (hasNsfwWords(model.name) || model.nsfw === true)) return false;
          if ((isOwner || isModerator) && model.nsfwLevel === 0) return true;
          if (showHidden && !hiddenModels.get(model.id)) return false;
          if (!Flags.intersects(model.nsfwLevel, browsingLevel)) {
            hidden.browsingLevel++;
            return false;
          }
          if (userId && hiddenUsers.get(userId)) {
            hidden.users++;
            return false;
          }
          if (hiddenModels.get(model.id) && !showHidden) {
            hidden.models++;
            return false;
          }
          for (const tag of model.tags ?? []) {
            if (hiddenTags.get(tag)) {
              hidden.tags++;
              return false;
            }

            if (systemHiddenTags.get(tag) && !isOwner) {
              hidden.tags++;
              return false;
            }
          }

          if (model.minor && minorDisabled) {
            hidden.minor++;
            return false;
          }
          return true;
        })
        .map(({ images, ...x }) => {
          const isModelOwner = x.user.id === currentUser?.id;
          const filteredImages =
            images?.filter((i) => {
              const userId = i.userId;
              const isOwner = userId && userId === currentUser?.id;
              if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
              if (x.nsfw) {
                if (i.nsfwLevel > maxSelectedLevel) return false;
              } else if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
              if (hiddenImages.get(i.id)) return false;
              for (const tag of i.tags ?? []) {
                if (hiddenTags.get(tag)) return false;

                if (systemHiddenTags.get(tag) && !isOwner) {
                  return false;
                }
              }
              if (i.poi && poiDisabled && !isOwner) {
                hidden.poi++;
                return false;
              }

              if (i.minor && minorDisabled) {
                hidden.minor++;
                return false;
              }

              return true;
            }) ?? [];

          const sortedImages = x.nsfw
            ? filteredImages.sort((a, b) => {
                const aIntersects = Flags.intersects(a.nsfwLevel, browsingLevel);
                const bIntersects = Flags.intersects(b.nsfwLevel, browsingLevel);
                return aIntersects === bIntersects ? 0 : aIntersects ? -1 : 1;
              })
            : filteredImages;

          if (sortedImages.length === 0) {
            hidden.noImages++;
          }

          return sortedImages.length || (showImageless && (isModelOwner || isModerator))
            ? {
                ...x,
                images: filteredImages,
              }
            : null;
        })
        .filter(isDefined);

      return { items: models, hidden };
    case 'images':
      const images = value.filter((image) => {
        const userId = image.userId ?? image.user?.id;
        const isOwner = userId && userId === currentUser?.id;
        if ((isOwner || isModerator) && image.nsfwLevel === 0) return true;
        if (
          allowLowerLevels
            ? image.nsfwLevel > maxBrowsingLevel
            : !Flags.intersects(image.nsfwLevel, browsingLevel)
        ) {
          hidden.browsingLevel++;
          return false;
        }

        if (image.poi && poiDisabled && !isOwner) {
          hidden.poi++;
          return false;
        }

        if (image.minor && minorDisabled) {
          hidden.minor++;
          return false;
        }

        if (userId && hiddenUsers.get(userId)) {
          hidden.users++;
          return false;
        }
        if (hiddenImages.get(image.id) && !showHidden) {
          hidden.images++;
          return false;
        }
        for (const tag of image.tagIds ?? []) {
          if (hiddenTags.get(tag)) {
            hidden.tags++;
            return false;
          }

          if (systemHiddenTags.get(tag) && !isOwner) {
            hidden.tags++;
            return false;
          }
        }

        if (!currentUser?.isModerator && !!getBlockedNsfwWords(image.prompt).length) return false;

        return true;
      });

      return { hidden, items: images };
    case 'articles':
      const articles = value.filter((article) => {
        const userId = article.user.id;
        const isOwner = userId === currentUser?.id;
        if (!canViewNsfw && hasNsfwWords(article.title)) return false;
        if ((isOwner || isModerator) && article.nsfwLevel === 0) return true;
        if (!Flags.intersects(article.nsfwLevel, browsingLevel)) {
          hidden.browsingLevel++;
          return false;
        }
        if (article.userNsfwLevel && !Flags.intersects(article.userNsfwLevel, browsingLevel)) {
          hidden.browsingLevel++;
          return false;
        }
        if (article.user && hiddenUsers.get(article.user.id)) {
          hidden.users++;
          return false;
        }
        for (const tag of article.tags ?? []) {
          if (hiddenTags.get(tag.id)) {
            hidden.tags++;
            return false;
          }

          if (systemHiddenTags.get(tag.id) && !isOwner) {
            hidden.tags++;
            return false;
          }
        }
        if (article.coverImage) {
          if (hiddenImages.get(article.coverImage.id)) {
            hidden.images++;
            return false;
          }

          if (article.coverImage.poi && poiDisabled && !isOwner) {
            hidden.poi++;
            return false;
          }

          if (article.coverImage.minor && minorDisabled) {
            hidden.minor++;
            return false;
          }

          for (const tag of article.coverImage.tags) {
            if (hiddenTags.get(tag)) {
              hidden.tags++;
              return false;
            }

            if (systemHiddenTags.get(tag) && !isOwner) {
              hidden.tags++;
              return false;
            }
          }
        }
        return true;
      });

      return { hidden, items: articles };
    case 'users':
      const users = value.filter((user) => {
        if (user.id === currentUser?.id) return true;
        if (hiddenUsers.get(user.id)) {
          hidden.users++;
          return false;
        }
        return true;
      });

      return {
        hidden,
        items: users,
      };
    case 'collections':
      const collections = value
        .filter((collection) => {
          const userId = collection.userId ?? collection.user?.id;
          const isOwner = userId && userId === currentUser?.id;
          if ((isOwner || isModerator) && collection.nsfwLevel === 0) return true;
          if (!Flags.intersects(collection.nsfwLevel, browsingLevel)) {
            hidden.browsingLevel++;
            return false;
          }
          if (userId && hiddenUsers.get(userId)) {
            hidden.users++;
            return false;
          }
          if (collection.image) {
            if (hiddenImages.get(collection.image.id)) {
              hidden.images++;
              return false;
            }
            for (const tag of collection.image.tagIds ?? []) {
              if (hiddenTags.get(tag)) {
                hidden.images++;
              }

              if (systemHiddenTags.get(tag) && !isOwner) {
                hidden.images++;
              }
            }

            if (collection.image.poi && poiDisabled && !isOwner) {
              hidden.poi++;
              return false;
            }

            if (collection.image.minor && minorDisabled) {
              hidden.minor++;
              return false;
            }
          }
          return true;
        })
        .map(({ images = [], image, ...x }) => {
          const mergedImages = image ? [...images, image] : images;
          const filteredImages =
            mergedImages.filter((i) => {
              const userId = i.userId;
              const isOwner = userId === currentUser?.id;
              if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
              if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
              if (hiddenImages.get(i.id)) return false;
              for (const tag of i.tagIds ?? []) {
                if (hiddenTags.get(tag)) return false;
                if (systemHiddenTags.get(tag) && !isOwner) {
                  return false;
                }
              }
              if (i.poi && poiDisabled && !isOwner) {
                hidden.poi++;
                return false;
              }
              if (i.minor && minorDisabled) {
                hidden.minor++;
                return false;
              }
              return true;
            }) ?? [];

          if (filteredImages.length === 0) {
            hidden.noImages++;
          }

          return filteredImages.length || showImageless
            ? {
                ...x,
                images: filteredImages,
              }
            : null;
        })
        .filter(isDefined);

      return { items: collections, hidden };
    case 'bounties':
      const bounties = value
        .filter((bounty) => {
          const userId = bounty.user.id;
          const isOwner = userId === currentUser?.id;
          if (!canViewNsfw && hasNsfwWords(bounty.name)) return false;
          if ((isOwner || isModerator) && bounty.nsfwLevel === 0) return true;
          if (!Flags.intersects(bounty.nsfwLevel, browsingLevel)) {
            hidden.browsingLevel++;
            return false;
          }
          if (hiddenUsers.get(bounty.user.id)) {
            hidden.users++;
            return false;
          }
          for (const image of bounty.images ?? [])
            if (hiddenImages.get(image.id)) {
              hidden.images++;
              return false;
            }
          for (const tag of bounty.tags ?? []) {
            if (hiddenTags.get(tag)) {
              hidden.tags++;
              return false;
            }

            if (systemHiddenTags.get(tag) && !isOwner) {
              hidden.tags++;
              return false;
            }
          }
          return true;
        })
        .map(({ images, ...x }) => {
          const filteredImages = images?.filter((i) => {
            const userId = i.userId;
            const isOwner = userId === currentUser?.id;
            if ((isOwner || isModerator) && i.nsfwLevel === 0) return true;
            if (!Flags.intersects(i.nsfwLevel, browsingLevel)) return false;
            if (hiddenImages.get(i.id)) return false;
            for (const tag of i.tagIds ?? []) {
              if (hiddenTags.get(tag)) return false;
              if (systemHiddenTags.get(tag) && !isOwner) {
                return false;
              }
            }
            if (i.poi && poiDisabled && !isOwner) {
              hidden.poi++;
              return false;
            }
            if (i.minor && minorDisabled) {
              hidden.minor++;
              return false;
            }
            return true;
          });

          if (filteredImages?.length === 0) {
            hidden.noImages++;
          }

          return filteredImages.length
            ? {
                ...x,
                images: filteredImages,
              }
            : null;
        })
        .filter(isDefined);

      return { items: bounties, hidden };
    case 'posts':
      const posts = value
        .filter((post) => {
          const userId = post.userId ?? post.user?.id;
          const isOwner = userId && userId === currentUser?.id;
          if (!canViewNsfw && hasNsfwWords(post.title)) return false;
          if ((isOwner || isModerator) && post.nsfwLevel === 0) return true;
          if (!Flags.intersects(post.nsfwLevel, browsingLevel)) {
            hidden.browsingLevel++;
            return false;
          }
          if (userId && hiddenUsers.get(userId)) {
            hidden.users++;
            return false;
          }
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
            for (const tag of image.tagIds ?? []) {
              if (hiddenTags.get(tag)) return false;
              if (systemHiddenTags.get(tag) && !isOwner) {
                return false;
              }
            }
            if (image.poi && poiDisabled && !isOwner) {
              hidden.poi++;
              return false;
            }
            if (image.minor && minorDisabled) {
              hidden.minor++;
              return false;
            }
            return true;
          });

          if (filteredImages.length === 0) {
            hidden.noImages++;
          }

          return filteredImages.length || showImageless
            ? { ...post, images: filteredImages }
            : null;
        })
        .filter(isDefined);

      return { items: posts, hidden };
    case 'tags': {
      const moderatedTagIds = moderatedTags
        .filter((x) => !!x.nsfwLevel && Flags.intersects(x.nsfwLevel, browsingLevel))
        .map((x) => x.id);
      const tags = value.filter((tag) => {
        if (!canViewNsfw && hasNsfwWords(tag.name)) return false;
        if (hiddenTags.get(tag.id)) {
          hidden.tags++;
          return false;
        }

        if (systemHiddenTags.get(tag.id)) {
          hidden.tags++;
          return false;
        }

        if (
          !!tag.nsfwLevel &&
          tag.nsfwLevel > NsfwLevel.PG13 &&
          !moderatedTagIds.includes(tag.id)
        ) {
          hidden.browsingLevel++;
          return false;
        }
        return true;
      });

      return {
        items: tags,
        hidden,
      };
    }
    case 'tools':
      // No need to apply hidden preferences to tools
      return { items: value, hidden };
    default:
      throw new Error('unhandled hidden user preferences filter type');
  }
}

type BaseImage = {
  id: number;
  userId?: number | null;
  user?: { id: number };
  tagIds?: number[];
  nsfwLevel: number;
  poi?: boolean;
  minor?: boolean;
  prompt?: string;
};

type BaseModel = {
  id: number;
  user: { id: number };
  images: {
    id: number;
    tags?: number[];
    nsfwLevel: number;
    userId?: number;
    poi?: boolean;
    minor?: boolean;
  }[];
  tags?: number[];
  nsfwLevel: number;
  nsfw?: boolean;
  name?: string | null;
  minor?: boolean;
  poi?: boolean;
};

type BaseArticle = {
  id: number;
  user: { id: number };
  nsfwLevel: number;
  userNsfwLevel: number;
  tags?: {
    id: number;
  }[];
  title?: string | null;
  coverImage?: {
    id: number;
    tags: number[];
    nsfwLevel: number;
    poi?: boolean;
    minor?: boolean;
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
    poi?: boolean;
    minor?: boolean;
  } | null;
  images: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId: number;
    poi?: boolean;
    minor?: boolean;
  }[];
};

type BaseBounty = {
  id: number;
  user: { id: number };
  tags?: number[];
  nsfwLevel: number;
  nsfw?: boolean;
  name?: string | null;
  images: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId: number;
    poi?: boolean;
    minor?: boolean;
  }[];
};

type BasePost = {
  // id: number;
  userId?: number;
  user?: { id: number };
  nsfwLevel: number;
  title?: string | null;
  images?: {
    id: number;
    tagIds?: number[];
    nsfwLevel: number;
    userId?: number;
    user?: { id: number };
    poi?: boolean;
    minor?: boolean;
  }[];
};

type BaseTag = {
  id: number;
  nsfwLevel?: number;
  name?: string | null;
};

type BaseTool = {
  id: number;
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
  tools: BaseTool[];
};
