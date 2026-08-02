import clsx from 'clsx';
import { useMemo } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { useStickerContext } from '~/components/Sticker/StickerProvider';
import { STICKER_MAX_ASPECT_RATIO, STICKER_SIZE } from '~/shared/utils/sticker-token';

export function Sticker({
  cosmeticId,
  size = STICKER_SIZE.inline,
  className,
}: {
  cosmeticId: number;
  size?: number;
  className?: string;
}) {
  const context = useStickerContext();
  const standaloneIds = useMemo(() => (context ? [] : [cosmeticId]), [context, cosmeticId]);
  const standalone = useStickerCosmetics(standaloneIds);

  const { sticker: lookup, isLoading } = context ?? standalone;
  const sticker = lookup.get(cosmeticId);

  // A revoked or deleted sticker leaves the token in place with nothing to render.
  if (!sticker) return isLoading ? null : <span className="opacity-50">:sticker:</span>;

  return (
    <EdgeImage
      className={clsx('inline-block align-text-bottom', className)}
      src={sticker.url}
      alt={`:${sticker.slug}:`}
      title={`:${sticker.slug}:`}
      // Sized by height so portrait art isn't fetched at 4x the pixels it shows.
      // `optimized` is explicit because the automatic small-image optimization
      // keys on `width`, which we no longer send.
      options={{ height: size * 2, anim: sticker.animated, optimized: true }}
      style={{
        height: size,
        width: 'auto',
        maxWidth: size * STICKER_MAX_ASPECT_RATIO,
        objectFit: 'contain',
      }}
    />
  );
}
