import { useMemo } from 'react';
import { toMediaQuality } from '~/client-utils/edge-url';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { MediaQualityState } from '~/providers/media-quality-context';
import { MediaQualityContext } from '~/providers/media-quality-context';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * Resolves the viewer's media quality once, rather than per image.
 *
 * Entitlement is `isPaidMember`, NOT `isMember` — the latter is `tier != null`, which is true for
 * tier `'free'` and would hand lossless to everyone carrying a subscription row.
 *
 * Mount inside `CivitaiSessionProvider` (it reads the user) and inside `FeatureFlagsProvider`.
 */
export function MediaQualityProvider({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const features = useOptionalFeatureFlags();

  const canUseLossless = !!currentUser?.isPaidMember;
  const imageFormat = currentUser?.filePreferences?.imageFormat;
  const enabled = !!features?.mediaQualityDefault;

  const value = useMemo<MediaQualityState>(
    () => ({
      enabled,
      canUseLossless,
      quality: toMediaQuality({ imageFormat, canUseLossless }),
      heldAtCompressed: imageFormat === 'metadata' && !canUseLossless,
      imageFormat,
    }),
    [enabled, canUseLossless, imageFormat]
  );

  return <MediaQualityContext.Provider value={value}>{children}</MediaQualityContext.Provider>;
}
