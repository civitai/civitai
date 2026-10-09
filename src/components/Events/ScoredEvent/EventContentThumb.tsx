import { useElementSize } from '@mantine/hooks';
import { IconBox, IconFileText, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

const TYPE_ICON = { Image: IconPhoto, Model: IconBox, Article: IconFileText } as const;

/**
 * A piece of the viewer's content as a small card, optionally wearing a hat exactly as a feed card
 * does: the feed's own wrapper draws it on the top-left corner, outside the card's clipped,
 * rounded layer, and grows it while the card is hovered. Behind the viewer's browsing level the
 * picture blurs like any other image.
 */
export function EventContentThumb({
  entityType,
  image,
  hat,
  className,
  allowance = 4,
}: {
  entityType: string;
  image: (ImageProps & { entityId: number; entityType: string }) | null;
  hat?: EventDecorationData;
  /** Classes for the card itself (its radius, say). */
  className?: string;
  /**
   * How far past the card's top and left edges the hat may reach, in px: the room around the card
   * before something crops it. A feed card has 36; a tight grid or a padded button far less.
   */
  allowance?: number;
}) {
  const Icon = TYPE_ICON[entityType as keyof typeof TYPE_ICON] ?? IconPhoto;
  // The hat is sized for a feed card; on this smaller card it shrinks by the card's width. Until
  // that is measured the hat is hidden, rather than shown feed-sized for a frame.
  const { ref, width } = useElementSize();
  const card = (
    <div
      ref={ref}
      className={clsx(
        'relative aspect-[4/5] w-full overflow-hidden bg-gray-2 dark:bg-dark-5',
        className ?? 'rounded-md'
      )}
    >
      {image ? (
        <ImageGuard2 image={image} explain={false}>
          {(safe) =>
            safe ? (
              <EdgeMedia2
                src={image.url}
                name={image.name ?? image.id.toString()}
                alt=""
                type={image.type}
                metadata={image.metadata}
                width={320}
                className="size-full object-cover"
              />
            ) : (
              <MediaHash {...image} />
            )
          }
        </ImageGuard2>
      ) : (
        <div className="flex size-full items-center justify-center text-gray-6">
          <Icon size={28} stroke={1.5} />
        </div>
      )}
    </div>
  );
  if (!hat) return card;
  return (
    <TwCosmeticWrapper
      eventDecoration={hat}
      cardWidth={width || undefined}
      className={clsx(!width && '[&>button]:invisible')}
      style={{ '--event-decoration-allowance': `${allowance}px` } as CSSProperties}
    >
      {card}
    </TwCosmeticWrapper>
  );
}
