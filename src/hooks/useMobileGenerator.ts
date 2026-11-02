import { useMediaQuery } from '@mantine/hooks';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PHONE_MEDIA_QUERY } from '~/utils/phone-layout';

/**
 * True when the mobile generator is showing: the `mobileGenerator` flag is on and the window is a
 * phone. Off outside the flag provider, so shared inputs render their usual layout there.
 */
export function useMobileGenerator() {
  const enabled = !!useOptionalFeatureFlags()?.mobileGenerator;
  const isPhone = useMediaQuery(PHONE_MEDIA_QUERY, false, { getInitialValueInEffect: false });
  return enabled && isPhone;
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
