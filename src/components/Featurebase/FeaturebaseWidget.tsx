import Script from 'next/script';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function FeaturebaseWidget() {
  const user = useCurrentUser();
  if (!user) return null;

  return null;
  // return (
  //   <Script
  //     src="https://do.featurebase.app/js/widget.js"
  //     onLoad={() => {
  //       window?.FeaturebaseWidget?.init({
  //         organization: 'civitai',
  //         initialPage: 'MainView',
  //         jwtToken: user.feedbackToken,
  //         placement: 'right',
  //         fullScreen: true,
  //       });
  //     }}
  //   />
  // );
}

declare global {
  interface Window {
    FeaturebaseWidget: any; // @ts-ignore: - this is coming from featurebase
  }
}
