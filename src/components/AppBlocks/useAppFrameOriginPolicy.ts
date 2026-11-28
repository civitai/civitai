import { useState } from 'react';
import type { AppFrameOriginPolicy } from '~/components/AppBlocks/sandbox';
import { useMaybeAppContext } from '~/providers/AppProvider';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The frame-origin policy this host mount hands `intersectSandbox`, or `null` when there
 * is none (no `AppProvider`, or a tab whose boot carried no `appFrameDomains`). `null`
 * means: unverified frames stay opaque, trusted tiers keep their token as before.
 *
 * 🔴 FROZEN FOR THE MOUNT. A sandbox attribute applies when the frame navigates, not
 * when it changes, while the transport's opaque/pinned mode follows the attribute at
 * once. If the flags overlay arrived after the frame loaded and flipped the grant, the
 * transport would pin a real origin the loaded document does not have (or the
 * reverse) and every message would be dropped. So the first value is kept.
 */
export function useAppFrameOriginPolicy(): AppFrameOriginPolicy | null {
  const app = useMaybeAppContext();
  const features = useOptionalFeatureFlags();
  const [policy] = useState<AppFrameOriginPolicy | null>(() => {
    if (!app || !Array.isArray(app.appFrameDomains)) return null;
    return {
      domains: app.appFrameDomains,
      embedderHost: app.host ?? '',
      unverifiedEnabled: features?.appBlocksSameOriginFrames === true,
    };
  });
  return policy;
}
