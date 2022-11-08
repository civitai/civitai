import Image, { type ImageLoader, type ImageProps } from 'next/image';

const normalizeSrc = (src: string) => {
  return src.startsWith('/') ? src.slice(1) : src;
};

const cloudflareLoader: ImageLoader = ({ src, width, quality }) => {
  const params = [`width=${width}`];

  if (quality) {
    params.push(`quality=${quality}`);
  }

  const paramsString = params.join(',');
  return `/cdn-cgi/image/${paramsString}/${normalizeSrc(src)}`;
};

export function EdgeImage(props: Props) {
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image loader={cloudflareLoader} {...props} />;
}

type Props = Omit<ImageProps, 'loader'>;
