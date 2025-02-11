import { MediaType } from '~/shared/utils/prisma/enums';
import Head from 'next/head';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useAppContext } from '~/providers/AppProvider';

export function Meta<TImage extends { nsfwLevel: number; url: string; type?: MediaType }>({
  title,
  description,
  links = [],
  schema,
  deIndex,
  images,
  imageUrl,
}: {
  title?: string;
  description?: string;
  links?: React.LinkHTMLAttributes<HTMLLinkElement>[];
  schema?: object;
  deIndex?: boolean;
  images?: TImage | TImage[] | null;
  imageUrl?: string;
}) {
  const _images = images ? ([] as TImage[]).concat(images) : undefined;
  const _image = _images?.find((image) => getIsSafeBrowsingLevel(image.nsfwLevel));
  const _imageProps =
    _image?.type === 'video' ? { anim: false, transcode: true, optimized: true } : {};
  const _imageUrl = _image ? getEdgeUrl(_image.url, { width: 1200, ..._imageProps }) : imageUrl;
  const { canIndex } = useAppContext();

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
      <meta property="og:type" content="website" />
      <meta property="twitter:card" content="summary_large_image" />
      {_imageUrl && (
        <>
          <meta property="og:image" content={_imageUrl} />
          <meta property="twitter:image" content={_imageUrl} />
          <meta name="robots" content="max-image-preview:large" />
        </>
      )}
      {(deIndex || !canIndex) && <meta name="robots" content="noindex,nofollow" />}
      {links.map((link, index) => (
        <link key={link.href || index} {...link} />
      ))}
      {schema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
          key="product-schema"
        ></script>
      )}
    </Head>
  );
}
