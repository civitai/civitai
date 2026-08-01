import clsx from 'clsx';
import { useMemo } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useEmojiCosmetics } from '~/components/Emoji/emoji.util';
import { useEmojiContext } from '~/components/Emoji/EmojiProvider';
import { EMOJI_SIZE } from '~/shared/utils/emoji-token';

export function Emoji({
  cosmeticId,
  size = EMOJI_SIZE.inline,
  className,
}: {
  cosmeticId: number;
  size?: number;
  className?: string;
}) {
  const context = useEmojiContext();
  const standaloneIds = useMemo(() => (context ? [] : [cosmeticId]), [context, cosmeticId]);
  const standalone = useEmojiCosmetics(standaloneIds);

  const { emoji: lookup, isLoading } = context ?? standalone;
  const emoji = lookup.get(cosmeticId);

  // A revoked or deleted emoji leaves the token in place with nothing to render.
  if (!emoji) return isLoading ? null : <span className="opacity-50">:emoji:</span>;

  return (
    <EdgeImage
      className={clsx('inline-block align-text-bottom', className)}
      src={emoji.url}
      alt={`:${emoji.slug}:`}
      title={`:${emoji.slug}:`}
      options={{ width: size * 2, anim: emoji.animated }}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}
