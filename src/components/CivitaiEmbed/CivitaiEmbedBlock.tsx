import { Button, Skeleton, Text } from '@mantine/core';
import { IconArrowsDiagonal, IconEyeOff, IconLinkOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import {
  BrowsingLevelProvider,
  useBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import type { EmbedImage, EmbedModel } from '~/components/CivitaiEmbed/CivitaiEmbedProvider';
import {
  useCivitaiEmbedContext,
  useEmbedView,
} from '~/components/CivitaiEmbed/CivitaiEmbedProvider';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Tooltip } from '~/components/MantineOverlays';
import { NextLink } from '~/components/NextLink/NextLink';
import { useTrackImpression } from '~/components/TrackView/useTrackImpression';
import { useInView } from '~/hooks/useInView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CivitaiEmbedDisplay } from '~/shared/tiptap/civitai-embed.node';
import type { CivitaiEmbedItem, CivitaiEmbedType } from '~/shared/tiptap/civitai-embed.utils';
import { getCivitaiEmbedHref, toCivitaiEmbedItem } from '~/shared/tiptap/civitai-embed.utils';
import { Flags } from '~/shared/utils/flags';

const typeLabel = { model: 'model', image: 'image' } as const;

type EntityProps = { item: CivitaiEmbedItem; data: EmbedModel | EmbedImage };

function EntityCard({ item, data }: EntityProps) {
  return item.type === 'model' ? (
    <ModelCard data={data as EmbedModel} linkVersionId={item.versionId} />
  ) : (
    <ImageCard data={data as EmbedImage} />
  );
}

function Tile({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex aspect-[7/9] w-full flex-col items-center justify-center gap-2 rounded-md border border-solid border-gray-3 bg-gray-0 p-4 text-center dark:border-dark-4 dark:bg-dark-6"
    >
      {children}
    </div>
  );
}

export function UnavailableTile({ item }: { item: CivitaiEmbedItem }) {
  const href = getCivitaiEmbedHref(item);
  return (
    <Tile testId="civitai-embed-unavailable">
      <IconLinkOff size={28} className="text-dimmed" />
      <Text size="sm" c="dimmed">
        This {typeLabel[item.type]} is not available
      </Text>
      <NextLink href={href} className="break-all text-xs">
        {href}
      </NextLink>
    </Tile>
  );
}

/**
 * Never renders the item's name or cover until Show: both can be explicit, and this viewer has
 * that level turned off. Only viewers with mature content on reach this; Show widens the level
 * for this one card, as ExplainHiddenImages' "Show Hidden" does, and the domain cap still wins.
 */
function MaturePlaceholder({
  item,
  data,
  Entity = EntityCard,
}: EntityProps & { Entity?: (props: EntityProps) => React.ReactElement }) {
  const browsingLevel = useBrowsingLevelDebounced();
  const [revealed, setRevealed] = useState(false);

  if (revealed)
    return (
      <BrowsingLevelProvider browsingLevel={Flags.addFlag(browsingLevel, data.nsfwLevel)}>
        <Entity item={item} data={data} />
      </BrowsingLevelProvider>
    );

  return <MatureTile type={item.type} onShow={() => setRevealed(true)} />;
}

/** Without onShow (mature content off), the tile only says something is hidden. */
export function MatureTile({ type, onShow }: { type: CivitaiEmbedType; onShow?: () => void }) {
  return (
    <Tile testId={onShow ? 'civitai-embed-mature' : 'civitai-embed-hidden'}>
      <IconEyeOff size={28} className="text-dimmed" />
      <Text size="xs" tt="uppercase" fw={600} c="dimmed">
        {typeLabel[type]}
      </Text>
      <Text size="sm" c="dimmed">
        {onShow ? 'Mature content, hidden by your browsing settings' : 'Mature content hidden'}
      </Text>
      {onShow && (
        <Button size="compact-sm" variant="light" onClick={onShow}>
          Show
        </Button>
      )}
    </Tile>
  );
}

function EmbedCard({ item, full }: { item: CivitaiEmbedItem; full?: boolean }) {
  const view = useEmbedView(item.type, item.id);
  const { ref, inView } = useInView();
  const requestLoad = useCivitaiEmbedContext()?.requestLoad;
  useEffect(() => {
    if (inView) requestLoad?.();
  }, [inView, requestLoad]);
  const Entity = full ? FullWidthMedia : EntityCard;

  return (
    <div ref={ref} data-testid="civitai-embed-item" className="w-full min-w-0">
      {view.state === 'loading' && <Skeleton className="aspect-[7/9] w-full" radius="md" />}
      {view.state === 'card' && <Entity item={item} data={view.data} />}
      {view.state === 'mature' && (
        <MaturePlaceholder item={item} data={view.data} Entity={Entity} />
      )}
      {view.state === 'hidden' && <MatureTile type={item.type} />}
      {view.state === 'unavailable' && <UnavailableTile item={item} />}
    </div>
  );
}

const FULL_WIDTH = 1200;
const MAX_HEIGHT = '80vh';

/**
 * One image or video at the article's column width. Gated by the same ImageGuard2 the image card
 * uses, so anything the card would blur is blurred here too.
 */
export function FullWidthMedia({ data }: EntityProps) {
  const image = data as EmbedImage;
  const { getImages, ...context } = useImagesContext();
  const features = useFeatureFlags();
  const ref = useTrackImpression([{ entityType: 'Image', entityId: image.id }]);
  const isVideo = image.type === 'video';
  const sized = !!image.width && !!image.height;
  // Column width, unless that would run taller than the screen: a portrait video would put its
  // controls below the fold.
  const box = sized
    ? {
        aspectRatio: `${image.width} / ${image.height}`,
        width: `min(100%, calc(${MAX_HEIGHT} * ${image.width} / ${image.height}))`,
      }
    : undefined;
  const routedDialog = {
    name: 'imageDetail' as const,
    state: { imageId: image.id, images: getImages(), ...context },
  };

  return (
    <div
      ref={ref}
      data-testid="civitai-embed-full"
      className={clsx(
        'relative mx-auto overflow-hidden rounded-md bg-gray-1 dark:bg-dark-6',
        !sized && 'w-full'
      )}
      style={box}
    >
      <ImageGuard2 image={image}>
        {(safe) => {
          const media = !safe ? (
            <MediaHash {...image} />
          ) : (
            <EdgeMedia2
              metadata={image.metadata as MixedObject}
              src={image.url}
              name={image.name ?? image.id.toString()}
              alt={image.name ?? undefined}
              type={image.type}
              imageId={image.id}
              thumbnailUrl={image.thumbnailUrl}
              width={FULL_WIDTH}
              sourceWidth={image.width}
              hiDpi={features.hiDpiPreviews}
              html5Controls={isVideo}
              muted={isVideo || undefined}
              videoProps={isVideo ? { keepPlaying: true } : undefined}
              placeholder="empty"
              // Overrides the article body's img max-height (80vh); the box above sizes this one.
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                maxWidth: '100%',
                maxHeight: sized ? '100%' : MAX_HEIGHT,
              }}
              wrapperProps={{ className: 'size-full' }}
            />
          );
          return (
            <>
              {/* A video's own controls take its clicks, so it opens from a corner link instead. */}
              {isVideo && safe ? (
                media
              ) : (
                <RoutedDialogLink
                  {...routedDialog}
                  className="block size-full"
                  aria-label={image.name || 'View media'}
                >
                  {media}
                </RoutedDialogLink>
              )}
              <div className="absolute left-2 top-2 flex gap-1">
                <ImageGuard2.BlurToggle />
              </div>
              {isVideo && safe && (
                <Tooltip label="Open in viewer" position="left">
                  <div className="absolute right-2 top-2">
                    <RoutedDialogLink
                      {...routedDialog}
                      aria-label="Open in viewer"
                      className="flex size-11 items-center justify-center rounded-lg bg-black/60 text-white hover:bg-black/80 sm:size-9"
                    >
                      <IconArrowsDiagonal size={18} aria-hidden />
                    </RoutedDialogLink>
                  </div>
                </Tooltip>
              )}
            </>
          );
        }}
      </ImageGuard2>
    </div>
  );
}

export function CivitaiEmbedBlock({
  items: rawItems,
  display,
}: {
  items: unknown;
  display?: CivitaiEmbedDisplay;
}) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(toCivitaiEmbedItem)
    .filter((item): item is CivitaiEmbedItem => !!item);
  if (!items.length) return null;

  // Full width only means something for a lone image or video; anything else stays a card row.
  if (display === 'full' && items.length === 1 && items[0].type === 'image')
    return (
      <div data-type="civitaiEmbed" className="my-4 w-full">
        <EmbedCard item={items[0]} full />
      </div>
    );

  return (
    <EmbedRow count={items.length}>
      {items.map((item, index) => (
        <EmbedCard key={`${item.type}-${item.id}-${index}`} item={item} />
      ))}
    </EmbedRow>
  );
}

/** Feed-card width (~300px), up to three across, two on a phone. */
export function EmbedRow({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div
      data-type="civitaiEmbed"
      className={clsx(
        'my-4 grid gap-3',
        count === 1 && 'max-w-[300px] grid-cols-1',
        count === 2 && 'max-w-[612px] grid-cols-2',
        count >= 3 && 'max-w-[924px] grid-cols-2 sm:grid-cols-3'
      )}
    >
      {children}
    </div>
  );
}
