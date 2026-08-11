/**
 * Recent Source Images
 *
 * Images the user has used as generation input, so they can be re-picked instead of
 * re-uploaded on every workflow. Deliberately separate from `sourceMetadataStore`,
 * which holds richer data but evicts on image removal and lives in sessionStorage —
 * both wrong for a history list.
 *
 * Stores only what the picker renders. Entries are pruned when the orchestrator
 * confirms a blob is gone, never on a mere image load failure.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const MAX_RECENT_SOURCE_IMAGES = 20;

export type RecentSourceImage = {
  url: string;
  width: number;
  height: number;
  lastUsedAt: number;
};

type RecentSourceImagesState = {
  images: RecentSourceImage[];
  record: (images: Omit<RecentSourceImage, 'lastUsedAt'>[]) => void;
  replaceUrl: (oldUrl: string, newUrl: string) => void;
  forget: (urls: string[]) => void;
  clear: () => void;
};

/**
 * Identity of a source image. Presigned urls carry a `sig`/`exp` that rotates on every
 * refresh, so the same blob arrives under many full urls — compare without the query.
 */
export function sourceImageKey(url: string) {
  return url.split('?')[0];
}

/**
 * Newest first, one entry per blob. Applied on write AND on read — a store persisted
 * by an older build, or one whose urls converged after a refresh, can still hold
 * two entries for the same image.
 */
export function dedupeSourceImages(images: RecentSourceImage[]) {
  const byKey = new Map<string, RecentSourceImage>();
  for (const img of [...images].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    const key = sourceImageKey(img.url);
    if (!byKey.has(key)) byKey.set(key, img);
  }
  return [...byKey.values()];
}

function sortAndCap(images: RecentSourceImage[]) {
  return dedupeSourceImages(images).slice(0, MAX_RECENT_SOURCE_IMAGES);
}

export const useRecentSourceImagesStore = create<RecentSourceImagesState>()(
  persist(
    (set) => ({
      images: [],

      record: (incoming) => {
        const valid = incoming.filter((img) => img.url && img.width && img.height);
        if (!valid.length) return;
        set((state) => {
          const now = Date.now();
          // Incoming first so that on a key collision its url wins — the existing
          // one's signature is the older, closer-to-expiring of the two.
          return {
            images: sortAndCap([
              ...valid.map((img) => ({ ...img, lastUsedAt: now })),
              ...state.images,
            ]),
          };
        });
      },

      replaceUrl: (oldUrl, newUrl) => {
        const key = sourceImageKey(oldUrl);
        set((state) => ({
          images: state.images.map((img) =>
            sourceImageKey(img.url) === key ? { ...img, url: newUrl } : img
          ),
        }));
      },

      forget: (urls) => {
        if (!urls.length) return;
        const drop = new Set(urls.map(sourceImageKey));
        set((state) => ({
          images: state.images.filter((img) => !drop.has(sourceImageKey(img.url))),
        }));
      },

      clear: () => set({ images: [] }),
    }),
    {
      name: 'recent-source-images',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components */
export const recentSourceImagesStore = {
  record: (images: Omit<RecentSourceImage, 'lastUsedAt'>[]) =>
    useRecentSourceImagesStore.getState().record(images),
  replaceUrl: (oldUrl: string, newUrl: string) =>
    useRecentSourceImagesStore.getState().replaceUrl(oldUrl, newUrl),
  forget: (urls: string[]) => useRecentSourceImagesStore.getState().forget(urls),
  clear: () => useRecentSourceImagesStore.getState().clear(),
  getImages: () => useRecentSourceImagesStore.getState().images,
};
