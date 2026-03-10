import { useEffect, useRef } from 'react';
import type { MediaType } from '~/shared/utils/prisma/enums';
import Head from 'next/head';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useAppContext } from '~/providers/AppProvider';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { create } from 'zustand';

// Meta stacking context - only the topmost (latest mounted) Meta renders its tags.
// When a dialog mounts its own Meta, it automatically suppresses the page's Meta.
// When the dialog unmounts, the page's Meta becomes active again.
let nextMetaId = 0;
const useMetaStack = create<{ stack: number[] }>(() => ({ stack: [] }));

function useMetaLevel() {
  const idRef = useRef<number>();
  if (idRef.current === undefined) idRef.current = nextMetaId++;

  const id = idRef.current;

  useEffect(() => {
    useMetaStack.setState((state) => ({ stack: [...state.stack, id] }));
    return () => {
      useMetaStack.setState((state) => ({ stack: state.stack.filter((x) => x !== id) }));
    };
  }, [id]);

  const isTop = useMetaStack((state) => state.stack[state.stack.length - 1] === id);
  return isTop;
}

export function Meta<TImage extends { nsfwLevel: number; url: string; type?: MediaType }>({
  title,
  description,
  links = [],
  schema,
  deIndex,
  images,
  imageUrl,
  keywords,
}: {
  title?: string;
  description?: string;
  links?: React.LinkHTMLAttributes<HTMLLinkElement>[];
  schema?: object;
  deIndex?: boolean;
  images?: TImage | TImage[] | null;
  imageUrl?: string;
  keywords?: string | string[];
}) {
  const _images = images ? ([] as TImage[]).concat(images) : undefined;
  const _image = _images?.find((image) => getIsSafeBrowsingLevel(image.nsfwLevel));
  const _imageProps =
    _image?.type === 'video' ? { anim: false, transcode: true, optimized: true } : {};
  const _imageUrl = _image ? getEdgeUrl(_image.url, { width: 1200, ..._imageProps }) : imageUrl;
  const { query } = useBrowserRouter();
  const hasDialogParam = !!(query as Record<string, unknown>)?.dialog;
  const { canIndex } = useAppContext();
  const stringifiedKeywords = Array.isArray(keywords) ? keywords.join(', ') : keywords;

  const isTop = useMetaLevel();

  if (!isTop) return null;

  return (
    <Head>
      {title && (
        <>
          <title>{title}</title>
          <meta name="title" content={title} />
          <meta property="og:title" content={title} />
          <meta property="twitter:title" content={title} />
        </>
      )}
      {description && (
        <>
          <meta name="description" content={description} />
          <meta property="og:description" content={description} />
          <meta property="twitter:description" content={description} />
        </>
      )}
      {stringifiedKeywords && <meta name="keywords" content={stringifiedKeywords} />}
      <meta property="og:type" content="website" />
      <meta property="twitter:card" content="summary_large_image" />
      {_imageUrl && (
        <>
          <meta property="og:image" content={_imageUrl} />
          <meta property="twitter:image" content={_imageUrl} />
          <meta name="robots" content="max-image-preview:large" />
        </>
      )}
      {(deIndex || !canIndex || hasDialogParam) && (
        <meta name="robots" content="noindex,nofollow" />
      )}
      {links.map((link, index) => (
        <link key={link.rel ? `link-${link.rel}` : link.href || index} {...link} />
      ))}
      {schema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
          key="product-schema"
        />
      )}
    </Head>
  );
}
