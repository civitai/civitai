import { useSyncExternalStore } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isPhoneScreen, PHONE_MEDIA_QUERY } from '~/utils/phone-layout';

function subscribeToScreen(onChange: () => void) {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  window.screen.orientation?.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
    window.screen.orientation?.removeEventListener('change', onChange);
  };
}

/** `isPhoneScreen`, re-read when the window resizes or the device rotates. */
function usePhoneScreen() {
  return useSyncExternalStore(subscribeToScreen, isPhoneScreen, () => false);
}

/**
 * True when the mobile generator is showing: the `mobileGenerator` flag is on and the window is a
 * phone. Off outside the flag provider, so shared inputs render their usual layout there.
 */
export function useMobileGenerator() {
  const enabled = !!useOptionalFeatureFlags()?.mobileGenerator;
  const narrow = useMediaQuery(PHONE_MEDIA_QUERY, false, { getInitialValueInEffect: false });
  const phoneScreen = usePhoneScreen();
  return enabled && (narrow || phoneScreen);
}

/**
 * `narrow` is the legacy generator under 768px, which keeps its own phone behaviour until the flag
 * is on for everyone.
 */
export type GeneratorLayout = 'mobile' | 'narrow' | 'desktop';

export function useGeneratorLayout(): GeneratorLayout {
  const mobile = useMobileGenerator();
  const narrow = useIsMobile({ type: 'media' });
  if (mobile) return 'mobile';
  return narrow ? 'narrow' : 'desktop';
}
