import { useFeatureFlags } from './FeatureFlagsProvider';
import { isProd } from '~/env/other';
import { GoogleAnalytics as NextGoogleAnalytics } from '@next/third-parties/google';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';

export function GoogleAnalytics() {
  const features = useFeatureFlags();
  const { allowed } = useThirdPartyConsent();

  if (!isProd) return null;
  if (!features.isGreen && !features.isBlue && !features.isRed) return null;
  if (!allowed) return null;
  const id = features.isGreen ? googleAnalyticsIds.blue : googleAnalyticsIds.red;

  return <NextGoogleAnalytics gaId={id} />;
}

const googleAnalyticsIds = {
  green: 'G-M1H0EH05SC',
  blue: 'G-N6W8XF7DXE',
  red: 'G-WETBV80N2V',
};
