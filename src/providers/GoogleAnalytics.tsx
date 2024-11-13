import Script from 'next/script';
import { useFeatureFlags } from './FeatureFlagsProvider';

export function GoogleAnalytics() {
  const features = useFeatureFlags();

  const id = features.isGreen ? googleAnalyticsIds.green : googleAnalyticsIds.blue;
  if (features.isBlue) return null;

  return (
    <>
      <Script
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
      ></Script>
    </>
  );
}

const googleAnalyticsIds = {
  green: 'G-M1H0EH05SC',
  blue: 'G-N6W8XF7DXE',
};
