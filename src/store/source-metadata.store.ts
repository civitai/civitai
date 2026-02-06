/**
 * Source Metadata Store
 *
 * Caches extracted metadata (params/resources) from images for use in enhancement workflows.
 * When an image is used in an enhancement workflow, we need the original generation metadata
 * to store alongside the enhancement transformation.
 *
 * Metadata is keyed by image URL and persisted to sessionStorage.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface SourceMetadata {
  /** Original generation parameters */
  params?: Record<string, unknown>;
  /** Original generation resources */
  resources?: Array<Record<string, unknown>>;
  /** Enhancement transformations applied to the original generation */
  transformations?: Array<{
    workflow: string;
    params: Record<string, unknown>;
    resources: Array<Record<string, unknown>>;
  }>;
  /** Timestamp when metadata was extracted/stored */
  extractedAt: number;
}

interface SourceMetadataState {
  /** Metadata keyed by image URL */
  metadataByUrl: Record<string, SourceMetadata>;

  /** Store metadata for an image URL */
  setMetadata: (url: string, metadata: Omit<SourceMetadata, 'extractedAt'>) => void;

  /** Get metadata for an image URL */
  getMetadata: (url: string) => SourceMetadata | undefined;

  /** Remove metadata for an image URL */
  removeMetadata: (url: string) => void;

  /** Clear all metadata */
  clearAll: () => void;
}

export const useSourceMetadataStore = create<SourceMetadataState>()(
  persist(
    (set, get) => ({
      metadataByUrl: {},

      setMetadata: (url, metadata) => {
        set((state) => ({
          metadataByUrl: {
            ...state.metadataByUrl,
            [url]: {
              ...metadata,
              extractedAt: Date.now(),
            },
          },
        }));
      },

      getMetadata: (url) => {
        return get().metadataByUrl[url];
      },

      removeMetadata: (url) => {
        set((state) => {
          const { [url]: _, ...rest } = state.metadataByUrl;
          return { metadataByUrl: rest };
        });
      },

      clearAll: () => {
        set({ metadataByUrl: {} });
      },
    }),
    {
      name: 'source-metadata',
      storage: createJSONStorage(() => sessionStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components */
export const sourceMetadataStore = {
  setMetadata: (url: string, metadata: Omit<SourceMetadata, 'extractedAt'>) => {
    useSourceMetadataStore.getState().setMetadata(url, metadata);
  },
  getMetadata: (url: string) => {
    return useSourceMetadataStore.getState().getMetadata(url);
  },
  removeMetadata: (url: string) => {
    useSourceMetadataStore.getState().removeMetadata(url);
  },
  clearAll: () => {
    useSourceMetadataStore.getState().clearAll();
  },
};
