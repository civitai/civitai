import { createContext, useContext } from 'react';
import type { MediaQuality } from '~/client-utils/edge-url';

export type MediaQualityState = {
  /** Whether the media-quality rules are live for this viewer. Off = the pre-flag URLs. */
  enabled: boolean;
  canUseLossless: boolean;
  quality: MediaQuality;
  /** Chose lossless, isn't entitled to it. Drives the upsell in the settings select. */
  heldAtCompressed: boolean;
  /** The persisted value, unchanged by entitlement — the settings select still shows the choice. */
  imageFormat?: string | null;
};

/**
 * Separate from the provider component on purpose, and the split is load-bearing.
 *
 * `useEdgeUrl` runs on every image in the app, so whatever it imports lands in the import graph of
 * nearly every suite. The provider has to read `~/providers/FeatureFlagsProvider`; if that import
 * sat in the same module, a wholesale `vi.mock` of the flags module naming only `useFeatureFlags`
 * — the repo's prevailing style, 52 files at last count — would fail to bind the other hook and
 * the importing test file would not COLLECT. That reports as zero tests, not as a failure. See
 * `src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts` for the incident.
 *
 * So: this module imports nothing but React and a type. The provider imports this.
 */
export const DEFAULT_MEDIA_QUALITY: MediaQualityState = {
  enabled: false,
  canUseLossless: false,
  quality: 'compressed',
  heldAtCompressed: false,
};

export const MediaQualityContext = createContext<MediaQualityState>(DEFAULT_MEDIA_QUALITY);

/** Falls back to the pre-flag behaviour outside the provider, which is what tests and any tree
 * mounted above it should get. */
export function useMediaQuality() {
  return useContext(MediaQualityContext);
}
