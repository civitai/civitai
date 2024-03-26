import { isDefined } from '~/utils/type-guards';

// export const applyUserPreferencesModels = <
//   T extends {
//     id: number;
//     user?: {
//       id: number;
//     };
//     tags: {
//       id: number;
//     }[];
//     images: {
//       id: number;
//       tags: {
//         id: number;
//       }[];
//     }[];
//   }
// >({
//   items,
//   currentUserId,
//   hiddenModels,
//   hiddenImages,
//   hiddenTags,
//   hiddenUsers,
// }: {
//   items: T[];
//   hiddenModels: Map<number, boolean>;
//   hiddenImages: Map<number, boolean>;
//   hiddenTags: Map<number, boolean>;
//   hiddenUsers: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items
//     .filter((x) => {
//       if (x.user) {
//         if (x.user.id === currentUserId) return true;
//         if (hiddenUsers.get(x.user.id)) return false;
//       }
//       if (hiddenModels.get(x.id)) return false;
//       for (const tag of x.tags ?? []) if (hiddenTags.get(tag.id)) return false;
//       return true;
//     })
//     .map(({ images, ...x }) => {
//       const filteredImages = images?.filter((i) => {
//         if (hiddenImages.get(i.id)) return false;

//         for (const tag of i.tags ?? []) {
//           if (hiddenTags.get(tag.id)) return false;
//         }
//         return true;
//       }) as T['images'];

//       if (!filteredImages?.length) return null;

//       const { tags, ...image } = filteredImages[0] as T['images'][number];

//       // TODO - don't mutate data if the intention is to make this reusable
//       return {
//         ...x,
//         // Search index stores tag name for searching purposes. We need to convert it back to id
//         tags: x.tags.map((t) => t.id),
//         image: {
//           ...image,
//           // Search index stores tag name for searching purposes. We need to convert it back to id
//           tags: tags?.map((t) => t.id),
//         },
//       };
//     })
//     .filter(isDefined);

//   return filtered;
// };

// export const applyUserPreferencesImages = <
//   T extends {
//     id: number;
//     user?: {
//       id: number;
//     };
//     tags?: {
//       id: number;
//     }[];
//   }
// >({
//   items,
//   currentUserId,
//   hiddenImages,
//   hiddenTags,
//   hiddenUsers,
// }: {
//   items: T[];
//   hiddenImages: Map<number, boolean>;
//   hiddenTags: Map<number, boolean>;
//   hiddenUsers: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items.filter((x) => {
//     if (x.user) {
//       if (x.user.id === currentUserId) return true;
//       if (hiddenUsers.get(x.user.id)) return false;
//     }
//     if (hiddenImages.get(x.id)) return false;
//     for (const tag of x.tags ?? []) if (hiddenTags.get(tag.id)) return false;
//     return true;
//   });

//   return filtered;
// };

// export const applyUserPreferencesArticles = <
//   T extends {
//     id: number;
//     user?: {
//       id: number;
//     };
//     tags?: {
//       id: number;
//     }[];
//   }
// >({
//   items,
//   currentUserId,
//   hiddenTags,
//   hiddenUsers,
// }: {
//   items: T[];
//   hiddenTags: Map<number, boolean>;
//   hiddenUsers: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items.filter((x) => {
//     if (x.user) {
//       if (x.user.id === currentUserId) return true;
//       if (hiddenUsers.get(x.user.id)) return false;
//     }
//     for (const tag of x.tags ?? []) if (hiddenTags.get(tag.id)) return false;
//     return true;
//   });

//   return filtered;
// };

// export const applyUserPreferencesUsers = <
//   T extends {
//     id: number;
//   }
// >({
//   items,
//   currentUserId,
//   hiddenUsers,
// }: {
//   items: T[];
//   hiddenUsers: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items.filter((x) => {
//     if (x.id === currentUserId) return true;
//     if (hiddenUsers.get(x.id)) return false;
//     return true;
//   });

//   return filtered;
// };

// export const applyUserPreferencesCollections = <
//   T extends {
//     id: number;
//     userId?: number;
//     user?: {
//       id: number;
//     };
//     image: {
//       id: number;
//       tags?:
//         | {
//             id: number;
//           }[]
//         | number[]
//         | null;
//     } | null;
//     images: {
//       id: number;
//       tags?:
//         | {
//             id: number;
//           }[]
//         | number[]
//         | null;
//     }[];
//   }
// >({
//   items,
//   currentUserId,
//   hiddenImages,
//   hiddenUsers,
//   hiddenTags,
// }: {
//   items: T[];
//   hiddenImages: Map<number, boolean>;
//   hiddenUsers: Map<number, boolean>;
//   hiddenTags: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items
//     .filter((x) => {
//       const userId = x.user?.id || x.userId;
//       if (userId === currentUserId) return true;
//       if (userId && hiddenUsers.get(userId)) return false;
//       if (x.image) {
//         // Cover photo:
//         if (hiddenImages.get(x.image.id)) {
//           return false;
//         }

//         for (const tag of x.image.tags ?? []) {
//           if (typeof tag === 'number') {
//             if (hiddenTags.get(tag)) return false;
//           } else {
//             if (hiddenTags.get(tag.id)) return false;
//           }
//         }
//       }

//       return true;
//     })
//     .map(({ images, ...x }) => {
//       const filteredImages = images?.filter((i) => {
//         if (hiddenImages.get(i.id)) return false;

//         for (const tag of i.tags ?? []) {
//           if (typeof tag === 'number') {
//             if (hiddenTags.get(tag)) return false;
//           } else {
//             if (hiddenTags.get(tag.id)) return false;
//           }
//         }

//         return true;
//       }) as T['images'];

//       if (!filteredImages?.length && !x.image) return null;

//       return {
//         ...x,
//         images: filteredImages,
//       };
//     })
//     .filter(isDefined);

//   return filtered;
// };

// export const applyUserPreferencesBounties = <
//   T extends {
//     id: number;
//     userId?: number;
//     user?: {
//       id: number;
//     } | null;
//     tags?:
//       | {
//           id: number;
//         }[]
//       | number[]
//       | null;
//     images: {
//       id: number;
//       tags?:
//         | {
//             id: number;
//           }[]
//         | number[]
//         | null;
//     }[];
//   }
// >({
//   items,
//   currentUserId,
//   hiddenImages,
//   hiddenUsers,
//   hiddenTags,
// }: {
//   items: T[];
//   hiddenImages: Map<number, boolean>;
//   hiddenUsers: Map<number, boolean>;
//   hiddenTags: Map<number, boolean>;
//   currentUserId?: number | null;
// }) => {
//   const filtered = items
//     .filter((x) => {
//       const userId = x.user?.id || x.userId;
//       if (userId === currentUserId) return true;
//       if (userId && hiddenUsers.get(userId)) return false;

//       for (const tag of x.tags ?? []) {
//         if (typeof tag === 'number') {
//           if (hiddenTags.get(tag)) return false;
//         } else {
//           if (hiddenTags.get(tag.id)) return false;
//         }
//       }

//       return true;
//     })
//     .map(({ images, ...x }) => {
//       const filteredImages = images?.filter((i) => {
//         if (hiddenImages.get(i.id)) return false;

//         for (const tag of i.tags ?? []) {
//           if (typeof tag === 'number') {
//             if (hiddenTags.get(tag)) return false;
//           } else {
//             if (hiddenTags.get(tag.id)) return false;
//           }
//         }

//         return true;
//       }) as T['images'];

//       if (!filteredImages?.length) return null;

//       return {
//         ...x,
//         images: filteredImages,
//       };
//     })
//     .filter(isDefined);

//   return filtered;
// };

export const applyUserPreferencesClub = <
  T extends {
    id: number;
    nsfw: boolean;
    user?: {
      id: number;
    } | null;
    coverImage?: {
      id: number;
      tags?:
        | {
            id: number;
          }[]
        | number[]
        | null;
    } | null;
  }
>({
  items,
  currentUserId,
  hiddenImages,
  hiddenUsers,
  hiddenTags,
  showNsfw,
}: {
  items: T[];
  hiddenImages: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  currentUserId?: number | null;
  showNsfw: boolean;
}) => {
  const filtered = items
    .filter((x) => {
      const userId = x.user?.id;
      if (userId === currentUserId) return true;
      if (userId && hiddenUsers.get(userId)) return false;

      const { coverImage: i } = x;

      if (!i) return true;
      if (hiddenImages.get(i.id)) return false;

      for (const tag of i.tags ?? []) {
        if (typeof tag === 'number') {
          if (hiddenTags.get(tag)) return false;
        } else {
          if (hiddenTags.get(tag.id)) return false;
        }
      }

      if (!showNsfw && x.nsfw) return false;

      return true;
    })
    .filter(isDefined);

  return filtered;
};

export const applyUserPreferencesClubPost = <
  T extends {
    id: number;
    createdById?: number;
    createdBy?: {
      id: number;
    } | null;
    coverImage?: {
      id: number;
      tags?:
        | {
            id: number;
          }[]
        | number[]
        | null;
    } | null;
  }
>({
  items,
  currentUserId,
  hiddenImages,
  hiddenUsers,
  hiddenTags,
}: {
  items: T[];
  hiddenImages: Map<number, boolean>;
  hiddenUsers: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  currentUserId?: number | null;
}) => {
  const filtered = items
    .filter((x) => {
      const userId = x.createdBy?.id || x.createdById;
      if (userId === currentUserId) return true;
      if (userId && hiddenUsers.get(userId)) return false;

      const { coverImage: i } = x;

      if (!i) return true;
      if (hiddenImages.get(i.id)) return false;

      for (const tag of i.tags ?? []) {
        if (typeof tag === 'number') {
          if (hiddenTags.get(tag)) return false;
        } else {
          if (hiddenTags.get(tag.id)) return false;
        }
      }

      return true;
    })
    .filter(isDefined);

  return filtered;
};
