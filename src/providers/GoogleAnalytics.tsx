import Script from 'next/script';
import { useFeatureFlags } from './FeatureFlagsProvider';
import { isProd } from '~/env/other';
import { GoogleAnalytics as NextGoogleAnalytics } from '@next/third-parties/google';

export function GoogleAnalytics() {
  const features = useFeatureFlags();

  if (!isProd) return null;
  if (!features.isGreen && !features.isBlue) return null;
  const id = features.isGreen ? googleAnalyticsIds.green : googleAnalyticsIds.blue;

  return (
    <>
      {/* <Script
        async
        src={`https://www.googletagmanager.com/gtag/js?id=${id}`}
        strategy="afterInteractive"
      ></Script>
      <Script
        id="google-analytics"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());

          gtag('config', '${id}');
        `,
        }}
      ></Script> */}
      <NextGoogleAnalytics gaId={id} />
    </>
  );
}

const googleAnalyticsIds = {
  green: 'G-M1H0EH05SC',
  blue: 'G-N6W8XF7DXE',
};
