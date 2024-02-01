import Script from 'next/script';

// declare const window: Window & { dataLayer: Record<string, unknown>[] };

export function ConsentManager() {
  return (
    <>
      <Script id="get-consent-mode">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){
            console.log('gtag called', {arguments});
            dataLayer.push(arguments);
          }

          const consentMode = localStorage.getItem('consentMode')
            ? JSON.parse(localStorage.getItem('consentMode')).state.consentMode
            : null
          if(!consentMode){
              gtag('consent', 'default', {
                  'functionality_storage': 'granted',
                  'security_storage': 'granted',
                  'ad_storage': 'denied',
                  'ad_user_data': 'denied',
                  'ad_personalization': 'denied',
              });
          } else {
              gtag('consent', 'default', {
                'functionality_storage': 'granted',
                'security_storage': 'granted',
                'ad_storage': consentMode.marketing ? 'granted' : 'denied',
                'ad_user_data': consentMode.marketing ? 'granted' : 'denied',
                'ad_personalization': consentMode.marketing ? 'granted' : 'denied',
            });
          }
        `}
      </Script>
      <Script id="gtm">
        {`
          (function (w, d, s, l, i) {
              w[l] = w[l] || []; w[l].push({
                  'gtm.start':
                      new Date().getTime(), event: 'gtm.js'
              }); var f = d.getElementsByTagName(s)[0],
                  j = d.createElement(s), dl = l != 'dataLayer' ? '&l=' + l : ''; j.async = true; j.src =
                      'https://www.googletagmanager.com/gtm.js?id=' + i + dl; f.parentNode.insertBefore(j, f);
          })(window, document, 'script', 'dataLayer', 'GTM-5Z6C3PK4');
        `}
      </Script>
    </>
  );
}
