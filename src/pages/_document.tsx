import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core';
import Document, { Html, Main, NextScript, Head } from 'next/document';
import clsx from 'clsx';

export default class _Document extends Document {
  render() {
    const pageProps = this.props?.__NEXT_DATA__?.props?.pageProps;
    return (
      <Html {...mantineHtmlProps}>
        {/* <InlineStylesHead /> */}
        <Head>
          {/*
            Declare CSS cascade layer order BEFORE anything else in <head>.
            A layer's priority is fixed at its first appearance in the CSSOM,
            and Next 16 / Turbopack injects each CSS Module's `@layer modules`
            block at runtime — potentially before globals.css parses. Declaring
            the order here (the first node in <head>) makes it deterministic:
            preflight < theme < mantine < modules < unlayered Tailwind utils.
          */}
          <style
            dangerouslySetInnerHTML={{
              __html: '@layer tailwind-preflight, theme, mantine, modules;',
            }}
          />
          <ColorSchemeScript />
        </Head>
        <body
          className={clsx(pageProps.colorScheme, {
            ['red']: pageProps.flags.isRed,
          })}
        >
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

// type DocumentFiles = {
//   sharedFiles: readonly string[];
//   pageFiles: readonly string[];
//   allFiles: readonly string[];
// };

// class InlineStylesHead extends Head {
//   getCssLinks(files: DocumentFiles) {
//     const { assetPrefix, dynamicImports, optimizeFonts } = this.context;
//     const cssFiles = files.allFiles.filter((file) => file.endsWith('.css'));
//     const sharedFiles = new Set(files.sharedFiles);

//     // Unmanaged files are CSS files that will be handled directly by the
//     // webpack runtime (`mini-css-extract-plugin`).
//     let dynamicCssFiles = dedupe(dynamicImports.filter((file) => file.endsWith('.css')));
//     if (dynamicCssFiles.length) {
//       const existing = new Set(cssFiles);
//       dynamicCssFiles = dynamicCssFiles.filter(
//         (file) => !(existing.has(file) || sharedFiles.has(file))
//       );
//       cssFiles.push(...dynamicCssFiles);
//     }

//     let cssLinkElements: JSX.Element[] = [];
//     cssFiles.forEach((file) => {
//       cssLinkElements.push(
//         <style
//           key={file}
//           data-href={`${assetPrefix}/_next/${encodeURI(file)}`}
//           dangerouslySetInnerHTML={{
//             __html: readFileSync(join(process.cwd(), '.next', file), 'utf-8'),
//           }}
//         />
//       );
//     });

//     if (process.env.NODE_ENV !== 'development' && optimizeFonts) {
//       cssLinkElements = this.makeStylesheetInert(cssLinkElements) as JSX.Element[];
//     }

//     return cssLinkElements.length === 0 ? null : cssLinkElements;
//   }
// }

// function dedupe(bundles: string[]) {
//   const files = new Set();
//   const kept = [];

//   for (const bundle of bundles) {
//     if (files.has(bundle)) continue;
//     files.add(bundle);
//     kept.push(bundle);
//   }
//   return kept;
// }
