import { useElementSize } from '@mantine/hooks';
import { IconBox, IconFileText, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { EventDecorationOverlay } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { getEventDecorationClearLeft } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';

const TYPE_ICON = { Image: IconPhoto, Model: IconBox, Article: IconFileText } as const;

/**
 * A piece of the viewer's content as a small card, optionally wearing a hat drawn exactly as the
 * feed draws it. Behind the viewer's browsing level it blurs like any other image.
 */
export function EventContentThumb({
  entityType,
  image,
  hat,
  className,
}: {
  entityType: string;
  image: (ImageProps & { entityId: number; entityType: string }) | null;
  hat?: EventDecorationData;
  className?: string;
}) {
  const Icon = TYPE_ICON[entityType as keyof typeof TYPE_ICON] ?? IconPhoto;
  // The hat is sized for a feed card; on this smaller card it shrinks by the card's width. Until
  // that is measured there is no hat, rather than a feed-sized one for a frame.
  const { ref, width } = useElementSize();
  const wearing = hat && width > 0 ? hat : undefined;
  return (
    <div
      ref={ref}
      className={clsx(
        'relative aspect-[4/5] w-full overflow-hidden rounded-md bg-gray-2 dark:bg-dark-5',
        className
      )}
      style={
        wearing
          ? ({
              '--event-decoration-clear-left': `${getEventDecorationClearLeft(
                wearing,
                'inside',
                undefined,
                0,
                width
              )}px`,
            } as CSSProperties)
          : undefined
      }
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
      {wearing && (
        <EventDecorationOverlay decoration={wearing} placement="inside" cardWidth={width} />
      )}
    </div>
  );
}
