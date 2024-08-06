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

          <Script strategy="beforeInteractive" src="https://cmp.uniconsent.com/v2/stub.min.js" />
          <Script
            strategy="beforeInteractive"
            src="https://cmp.uniconsent.com/v2/a635bd9830/cmp.js"
            async
          />
          <Script
            id="ads-start"
            type="text/javascript"
            strategy="beforeInteractive"
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
        </body>
      </Html>
    );
  }
}
