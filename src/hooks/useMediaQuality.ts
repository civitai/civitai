import type { MediaQuality } from '~/client-utils/edge-url';
import { toMediaQuality } from '~/client-utils/edge-url';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

export type UseMediaQualityReturn = {
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
 * `useOptionalFeatureFlags`, not `useFeatureFlags`: this runs inside `useEdgeUrl`, i.e. on every
 * image in the app, including trees mounted outside the provider. Absent flags mean the pre-flag
 * behaviour, which is the correct fallback for a rollout switch.
 *
 * Entitlement is `isPaidMember`, NOT `isMember` — the latter is `tier != null`, which is true for
 * tier `'free'` and would hand lossless to everyone with a subscription row.
 */
export function useMediaQuality(): UseMediaQualityReturn {
  const currentUser = useCurrentUser();
  const features = useOptionalFeatureFlags();

  const canUseLossless = !!currentUser?.isPaidMember;
  const imageFormat = currentUser?.filePreferences?.imageFormat;

  return {
    enabled: !!features?.mediaQualityDefault,
    canUseLossless,
    quality: toMediaQuality({ imageFormat, canUseLossless }),
    heldAtCompressed: imageFormat === 'metadata' && !canUseLossless,
    imageFormat,
  };
}
