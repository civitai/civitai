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

          if(localStorage.getItem('consentMode') === null){
              gtag('consent', 'default', {
                  'functionality_storage': 'denied',
                  'security_storage': 'denied',
                  'ad_storage': 'denied',
                  'ad_user_data': 'denied',
                  'ad_personalization': 'denied',
              });
          } else {
              gtag('consent', 'default', JSON.parse(localStorage.getItem('consentMode')));
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
                      console.log('https://www.googletagmanager.com/gtm.js?id=' + i + dl);
          })(window, document, 'script', 'dataLayer', 'GTM-5Z6C3PK4');
        `}
      </Script>
    </>
  );
}
