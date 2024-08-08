import { createGetInitialProps } from '@mantine/next';
import Document, { Html, Main, NextScript, Head } from 'next/document';
import Script from 'next/script';

const getInitialProps = createGetInitialProps();

export default class _Document extends Document {
  static getInitialProps = getInitialProps;

  render() {
    return (
      <Html>
        <Head />
        <body>
          <Main />
          <NextScript />

          <Script
            id="ads-start"
            type="text/javascript"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `
                window.googletag = window.googletag || {};
                window.googletag.cmd = window.googletag.cmd || [];
                window.googletag.cmd.push(function () {
                  window.googletag.pubads().enableAsyncRendering();
                  window.googletag.pubads().disableInitialLoad();
                });
                (adsbygoogle = window.adsbygoogle || []).pauseAdRequests = 1;
              `,
            }}
          />
          <Script
            id="ads-init"
            type="text/javascript"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `
              __tcfapi("addEventListener", 2, function(tcData, success) {
                if (success && tcData.unicLoad  === true) {
                  if(!window._initAds) {
                    window._initAds = true;
                      
                    var script = document.createElement('script');
                    script.async = true;
                    script.src = '//dsh7ky7308k4b.cloudfront.net/publishers/civitaicom.min.js';
                    document.head.appendChild(script);
              
                    var script = document.createElement('script');
                    script.async = true;
                    script.src = '//btloader.com/tag?o=5184339635601408&upapi=true';
                    document.head.appendChild(script);
                  }
                }
              });
            `,
            }}
          />
          <Script strategy="beforeInteractive" src="https://cmp.uniconsent.com/v2/stub.min.js" />
          <Script
            strategy="beforeInteractive"
            src="https://cmp.uniconsent.com/v2/a635bd9830/cmp.js"
            async
          />
        </body>
      </Html>
    );
  }
}
