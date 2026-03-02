/**
 * Source Metadata Store
 *
 * Caches extracted metadata (params/resources) from images for use in enhancement workflows.
 * When an image is used in an enhancement workflow, we need the original generation metadata
 * to store alongside the enhancement transformation.
 *
 * Also stores drawing annotations for img2img:edit workflows, keyed by composite image URL.
 *
 * Metadata is keyed by image URL and persisted to sessionStorage.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DrawingElement } from '~/components/Generation/Input/DrawingEditor/drawing.types';

/** Drawing annotation data for a composite (drawn-on) image */
export interface SourceAnnotation {
  originalUrl: string;
  originalWidth: number;
  originalHeight: number;
  lines: DrawingElement[];
}

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
  /** Drawing annotation — tracks original image + drawing lines for re-editing */
  annotation?: SourceAnnotation;
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

  /** Store drawing annotation for a composite image URL (merges with existing metadata) */
  setAnnotation: (compositeUrl: string, annotation: SourceAnnotation) => void;

  /** Get drawing annotation for a composite image URL */
  getAnnotation: (compositeUrl: string) => SourceAnnotation | undefined;

  /** Remove drawing annotation for a composite image URL */
  removeAnnotation: (compositeUrl: string) => void;

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

      setAnnotation: (compositeUrl, annotation) => {
        set((state) => ({
          metadataByUrl: {
            ...state.metadataByUrl,
            [compositeUrl]: {
              ...state.metadataByUrl[compositeUrl],
              annotation,
              extractedAt: Date.now(),
            },
          },
        }));
      },

      getAnnotation: (compositeUrl) => {
        return get().metadataByUrl[compositeUrl]?.annotation;
      },

      removeAnnotation: (compositeUrl) => {
        set((state) => {
          const existing = state.metadataByUrl[compositeUrl];
          if (!existing?.annotation) return state;
          const { annotation: _, ...rest } = existing;
          return {
            metadataByUrl: {
              ...state.metadataByUrl,
              [compositeUrl]: rest as SourceMetadata,
            },
          };
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
  setAnnotation: (compositeUrl: string, annotation: SourceAnnotation) => {
    useSourceMetadataStore.getState().setAnnotation(compositeUrl, annotation);
  },
  getAnnotation: (compositeUrl: string) => {
    return useSourceMetadataStore.getState().getAnnotation(compositeUrl);
  },
  removeAnnotation: (compositeUrl: string) => {
    useSourceMetadataStore.getState().removeAnnotation(compositeUrl);
  },
  clearAll: () => {
    useSourceMetadataStore.getState().clearAll();
  },
};
