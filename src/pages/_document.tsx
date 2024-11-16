import { createGetInitialProps } from '@mantine/next';
import Document, { Html, Main, NextScript, Head } from 'next/document';

const getInitialProps = createGetInitialProps();

export default class _Document extends Document {
  static getInitialProps = getInitialProps;

  render() {
    const pageProps = this.props?.__NEXT_DATA__?.props?.pageProps;
    return (
      <Html>
        <Head />
        <body className={pageProps.colorScheme}>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
