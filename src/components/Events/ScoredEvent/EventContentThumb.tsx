import { IconBox, IconFileText, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { EventDecorationEntity } from '~/components/Cosmetics/EventDecoration/WornHatPopover';
import { coverRequestWidth } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

const TYPE_ICON = { Image: IconPhoto, Model: IconBox, Article: IconFileText } as const;

/**
 * A piece of the viewer's content as a small card, optionally wearing a hat exactly as a feed card
 * does: the feed's own wrapper draws it, feed-sized, on the top-left corner, outside the card's
 * clipped, rounded layer, and grows it while the card is hovered. A container with less room than
 * the feed sets `--event-decoration-allowance` (and `--event-decoration-grow`) around it. Behind
 * the viewer's browsing level the picture blurs like any other image.
 */
export function EventContentThumb({
  entityType,
  image,
  hat,
  className,
  wornOn,
  displayWidth = 450,
}: {
  entityType: string;
  image: (ImageProps & { entityId: number; entityType: string }) | null;
  hat?: EventDecorationData;
  /** Classes for the card itself (its radius, say). */
  className?: string;
  /**
   * The content this card stands for, when the hat is really on it: a click on the hat then opens
   * its stats, as on a feed card. Without it (a picker's candidates) a click only bursts.
   */
  wornOn?: EventDecorationEntity;
  /** About how wide the card is drawn at 2x, for the picture request. */
  displayWidth?: number;
}) {
  const Icon = TYPE_ICON[entityType as keyof typeof TYPE_ICON] ?? IconPhoto;
  const card = (
    <div
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
                width={coverRequestWidth(image, displayWidth)}
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
    <TwCosmeticWrapper eventDecoration={hat} eventDecorationOn={wornOn}>
      {card}
    </TwCosmeticWrapper>
  );
}
