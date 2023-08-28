import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { isDefined } from '~/utils/type-guards';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';

export const applyUserPreferencesModels = <T>({
  items,
  currentUserId,
  hiddenModels,
  hiddenImages,
  hiddenTags,
  hiddenUsers,
}: {
  items: {
    id: number;
    user: {
      id: number;
    };
    tags: {
      id: number;
    }[];
    images: {
      id: number;
      tags: {
        id: number;
      }[];
    }[];
  }[];
  hiddenModels: Map<number, boolean>;
  hiddenImages: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items
    .filter((x) => {
      if (x.user.id === currentUserId) return true;
      if (hiddenUsers.get(x.user.id)) return false;
      if (hiddenModels.get(x.id)) return false;
      for (const tag of x.tags) if (hiddenTags.get(tag.id)) return false;
      return true;
    })
    .map(({ images, ...x }) => {
      const filteredImages = images?.filter((i) => {
        if (hiddenImages.get(i.id)) return false;

        for (const tag of i.tags ?? []) {
          if (hiddenTags.get(tag.id)) return false;
        }
        return true;
      });

      if (!filteredImages?.length) return null;

      return {
        ...x,
        // Search index stores tag name for searching purposes. We need to convert it back to id
        tags: x.tags.map((t) => t.id),
        image: {
          ...filteredImages[0],
          // Search index stores tag name for searching purposes. We need to convert it back to id
          tags: filteredImages[0].tags?.map((t) => t.id),
        },
      };
    })
    .filter(isDefined);

  return filtered as T[];
};

export const applyUserPreferencesImages = <T>({
  items,
  currentUserId,
  hiddenImages,
  hiddenTags,
  hiddenUsers,
}: {
  items: {
    id: number;
    user: {
      id: number;
    };
    tags: {
      id: number;
    }[];
  }[];
  hiddenImages: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items.filter((x) => {
    if (x.user.id === currentUserId) return true;
    if (hiddenUsers.get(x.user.id)) return false;
    if (hiddenImages.get(x.id)) return false;
    for (const tag of x.tags) if (hiddenTags.get(tag.id)) return false;
    return true;
  });

  return filtered as T[];
};

export const applyUserPreferencesArticles = <T>({
  items,
  currentUserId,
  hiddenTags,
  hiddenUsers,
}: {
  items: {
    id: number;
    user: {
      id: number;
    };
    tags: {
      id: number;
    }[];
  }[];
  hiddenTags: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items.filter((x) => {
    if (x.user.id === currentUserId) return true;
    if (hiddenUsers.get(x.user.id)) return false;
    for (const tag of x.tags) if (hiddenTags.get(tag.id)) return false;
    return true;
  });

  return filtered as T[];
};

export const applyUserPreferencesUsers = <T>({
  items,
  currentUserId,
  hiddenUsers,
}: {
  items: {
    id: number;
  }[];
  hiddenUsers: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items.filter((x) => {
    if (x.id === currentUserId) return true;
    if (hiddenUsers.get(x.id)) return false;
    return true;
  });

  return filtered as T[];
};

export const applyUserPreferencesCollections = <T>({
  items,
  currentUserId,
  hiddenImages,
  hiddenUsers,
  hiddenTags,
}: {
  items: {
    id: number;
    user: {
      id: number;
    };
    image: {
      id: number;
      tags?:
        | {
            id: number;
          }[]
        | number[]
        | null;
    } | null;
    images: {
      id: number;
      tags?:
        | {
            id: number;
          }[]
        | number[]
        | null;
    }[];
  }[];
  hiddenImages: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items
    .filter((x) => {
      if (x.user.id === currentUserId) return true;
      if (hiddenUsers.get(x.user.id)) return false;
      if (x.image) {
        // Cover photo:
        if (hiddenImages.get(x.image.id)) {
          return false;
        }

        for (const tag of x.image.tags ?? []) {
          if (typeof tag === 'number') {
            if (hiddenTags.get(tag)) return false;
          } else {
            if (hiddenTags.get(tag.id)) return false;
          }
        }
      }

      return true;
    })
    .map(({ images, ...x }) => {
      const filteredImages = images?.filter((i) => {
        if (hiddenImages.get(i.id)) return false;

        for (const tag of i.tags ?? []) {
          if (typeof tag === 'number') {
            if (hiddenTags.get(tag)) return false;
          } else {
            if (hiddenTags.get(tag.id)) return false;
          }
        }

        return true;
      });

      if (!filteredImages?.length) return null;

      return {
        ...x,
        images: filteredImages,
      };
    })
    .filter(isDefined);

  return filtered as T[];
};
