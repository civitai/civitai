import clsx from 'clsx';
import { useMemo } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { useStickerContext } from '~/components/Sticker/StickerProvider';
import { STICKER_SIZE } from '~/shared/utils/sticker-token';

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
      options={{ width: size * 2, anim: sticker.animated }}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}
