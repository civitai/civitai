import { useMediaQuery } from '@mantine/hooks';
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
