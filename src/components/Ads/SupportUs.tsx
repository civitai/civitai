import Image from 'next/image';
import { NextLink } from '~/components/NextLink/NextLink';
import { getSupportUsImage } from '~/components/Ads/ads.utils';

// Rendered in place of an ad unit when ads are blocked. Deliberately carries no
// ad-slot structure, classes, ids, or dimensions in its markup so adblock cosmetic
// filters that strip ad containers leave it alone.
export function SupportUs({
  maxWidth = 300,
  maxHeight = 600,
  className = 'flex',
}: {
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}) {
  const image = getSupportUsImage(maxWidth, maxHeight);
  if (!image) return null;

  return (
    <NextLink href="/pricing" className={className}>
      <Image
        src={image.src}
        alt="Support Civitai creators"
        width={image.width}
        height={image.height}
        className="h-auto max-w-full"
      />
    </NextLink>
  );
}
