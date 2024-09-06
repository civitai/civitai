import { createGetInitialProps } from '@mantine/next';
import { DEFAULT_SCRIPT_ID, SCRIPT_URL } from '@marsidev/react-turnstile';
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
          <Script id={DEFAULT_SCRIPT_ID} src={SCRIPT_URL} strategy="beforeInteractive" />
        </body>
      </Html>
    );
  }
}
