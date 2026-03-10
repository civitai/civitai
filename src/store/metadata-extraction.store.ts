/**
 * Metadata Extraction Store
 *
 * Stores extracted metadata state from the img2meta workflow.
 * Bridges MetadataExtractionPanel (which writes extraction results)
 * and FormFooter (which renders remix/workflow action buttons).
 *
 * Memory-only — no persistence needed since this is transient session state.
 */

import { create } from 'zustand';

import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { GenerationResource } from '~/shared/types/generation.types';

interface MetadataExtractionState {
  metadata: ImageMetaProps | undefined;
  resolvedResources: GenerationResource[];
  /** Graph-compatible params from the server (includes workflow, ecosystem, prompt, etc.) */
  params: Record<string, unknown> | undefined;
  fileUrl: string | undefined;
  isExtracting: boolean;
  isResolving: boolean;

  setMetadata: (metadata: ImageMetaProps | undefined) => void;
  setResolved: (resources: GenerationResource[], params: Record<string, unknown>) => void;
  setFileUrl: (url: string | undefined) => void;
  setIsExtracting: (extracting: boolean) => void;
  setIsResolving: (resolving: boolean) => void;
  clear: () => void;
}

const initialState: Pick<
  MetadataExtractionState,
  'metadata' | 'resolvedResources' | 'params' | 'fileUrl' | 'isExtracting' | 'isResolving'
> = {
  metadata: undefined,
  resolvedResources: [],
  params: undefined,
  fileUrl: undefined,
  isExtracting: false,
  isResolving: false,
};

export const useMetadataExtractionStore = create<MetadataExtractionState>()((set) => ({
  ...initialState,

  setMetadata: (metadata) => set({ metadata }),
  setResolved: (resolvedResources, params) => set({ resolvedResources, params }),
  setFileUrl: (fileUrl) => set({ fileUrl }),
  setIsExtracting: (isExtracting) => set({ isExtracting }),
  setIsResolving: (isResolving) => set({ isResolving }),
  clear: () => set(initialState),
}));

/** Standalone accessor for use outside React components */
export const metadataExtractionStore = {
  getState: () => useMetadataExtractionStore.getState(),
  clear: () => useMetadataExtractionStore.getState().clear(),
};
