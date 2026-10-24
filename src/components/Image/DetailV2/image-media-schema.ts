import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

type SchemaImage = {
  id: number;
  url: string | null;
  type?: string | null;
  nsfwLevel: number;
  width?: number | null;
  height?: number | null;
  createdAt?: Date | null;
  user: { username?: string | null; deletedAt?: Date | null };
};

/**
 * The VideoObject / ImageObject JSON-LD for an image detail page, or undefined when the media is
 * not safe-rated. Structured data is read by crawlers and link unfurlers that never see the page's
 * rating gate, so it follows the same rule as og:image and /api/og.
 */
export function buildImageMediaSchema({
  image,
  title,
  baseUrl,
}: {
  image: SchemaImage;
  title: string;
  baseUrl?: string;
}) {
  if (!getIsSafeBrowsingLevel(image.nsfwLevel) || !image.url) return undefined;

  const hasCreator = !!image.user.username && !image.user.deletedAt;
  const creator = hasCreator
    ? {
        '@type': 'Person',
        name: image.user.username,
        url: baseUrl ? `${baseUrl}/user/${image.user.username}` : undefined,
      }
    : { '@type': 'Person', name: 'Civitai user' };
  const creditText = hasCreator ? image.user.username : undefined;
  const copyrightNotice = hasCreator ? `© ${image.user.username}` : undefined;

  // Poster/thumbnail params mirror EdgeVideo's poster generation (anim=false,
  // transcode=true) so Google fetches the same static frame we render.
  if (image.type === 'video')
    return {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: title,
      description: title,
      contentUrl: getEdgeUrl(image.url, {
        type: 'video',
        width: 450,
        transcode: true,
        optimized: true,
        anim: true,
      }),
      thumbnailUrl: getEdgeUrl(image.url, {
        width: 450,
        anim: false,
        transcode: true,
        optimized: true,
        original: false,
      }),
      width: image.width ?? undefined,
      height: image.height ?? undefined,
      creator,
      creditText,
      copyrightNotice,
      uploadDate: image.createdAt,
    };

  return {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    contentUrl: getEdgeUrl(image.url),
    thumbnailUrl: getEdgeUrl(image.url, { width: 450 }),
    caption: image.user.username ? `Image by ${image.user.username}` : 'Image on Civitai',
    width: image.width ?? undefined,
    height: image.height ?? undefined,
    creator,
    creditText,
    copyrightNotice,
    acquireLicensePage: baseUrl ? `${baseUrl}/images/${image.id}` : undefined,
    uploadDate: image.createdAt,
    datePublished: image.createdAt,
  };
}
