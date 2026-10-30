import { useLocalStorage } from '@mantine/hooks';
import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { setMediaDragData } from '~/components/EdgeMedia/media-drag-data';
import { ImageStickerOverlay } from '~/components/Sticker/ImageStickerOverlay';
import { DrawnMediaHat } from '~/components/Cosmetics/EventDecoration/DrawnMediaHat';
import type { WornDecoration } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { shouldDisplayHtmlControls } from '~/components/EdgeMedia/EdgeMedia.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import type { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { UnstyledButton } from '@mantine/core';
import { isAdjacent } from '~/components/Image/DetailV2/image-detail-carousel.utils';
import { imageDetailMediaProps } from '~/components/Image/DetailV2/image-detail-main-media';
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import type { EmblaCarouselType } from 'embla-carousel';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { allowNativeDragStart, watchTouchDrag } from '~/components/EmblaCarousel/watchTouchDrag';

type ImageDetailCarouselProps = {
  videoRef?: React.ForwardedRef<EdgeVideoRef>;
  connect?: ConnectProps;
};
type ImageProps = {
  id: number;
  nsfwLevel: number;
  url: string;
  height: number | null;
  width: number | null;
  type: MediaType;
  name: string | null;
  metadata?: MixedObject | ImageMetadata | VideoMetadata | null;
  eventDecoration?: WornDecoration;
};

type Props<T> = Parameters<typeof useCarouselNavigation<T>>[0];
type State = ReturnType<typeof useCarouselNavigation<ImageProps>>;
const ImageDetailCarouselContext = createContext<State | null>(null);

function useImageDetailCarouselContext() {
  const context = useContext(ImageDetailCarouselContext);
  if (!context) throw new Error('missing ImageDetailCarouselContext in tree');
  return context;
}

export function ImageDetailCarouselProvider<T extends ImageProps>({
  children,
  ...args
}: Props<T> & { children: React.ReactNode }) {
  const state = useCarouselNavigation(args);

  return (
    <ImageDetailCarouselContext.Provider value={state}>
      {children}
    </ImageDetailCarouselContext.Provider>
  );
}

// VIDEO is here so arrow keys still seek a focused player with native controls
const IGNORED_HOTKEY_TAGS = ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO'];

function shouldHandleHotkey(event: KeyboardEvent, carouselRoot: HTMLElement | null) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  if (IGNORED_HOTKEY_TAGS.includes(target.tagName)) return false;
  if (target.closest('[role="menu"],[role="listbox"]')) return false;
  // A dialog stacked on top of the detail view (report, add-to-collection) owns
  // its own arrow handling. The detail view's own modal shell is also a dialog,
  // but it contains the carousel, which is what tells the two apart.
  const dialog = target.closest('[role="dialog"]');
  return !dialog || (!!carouselRoot && dialog.contains(carouselRoot));
}

// Comfortably longer than embla's scroll animation (duration 25), so it only
// ever fires for a 'settle' that was genuinely dropped.
export const SETTLE_FALLBACK_MS = 800;

export function ImageDetailCarousel({
  images,
  videoRef,
  connect,
  index,
  canNavigate,
  navigate,
  next,
  previous,
  onSettle,
  loop = true,
}: ImageDetailCarouselProps & {
  images: ImageProps[];
  index: number;
  navigate?: (index: number) => void;
  next: () => void;
  previous: () => void;
  onSettle?: (index: number) => void;
  canNavigate: boolean;
  /** Read once at mount, like every other embla option here; remount to change it. */
  loop?: boolean;
}) {
  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);
  const emblaRef = useRef<EmblaCarouselType | null>(null);

  // Embla owns the slide animation, but `index` is the source of truth. Feeding
  // it back in as `startIndex` would reInit the engine on every navigation,
  // which tears down the pointer handlers mid-swipe.
  //
  // Keep every other option static too: embla's `reActivate` merges the options
  // it is handed OVER the index it just preserved, so a changing option would
  // snap the carousel back to whichever image was open at mount.
  const startIndexRef = useRef(index);

  const navigationRef = useRef({ next, previous, canNavigate });
  navigationRef.current = { next, previous, canNavigate };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const { next, previous, canNavigate } = navigationRef.current;
      if (!canNavigate || !shouldHandleHotkey(event, emblaRef.current?.rootNode() ?? null)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') previous();
      else next();
    };

    // capture phase so the keypress reaches us regardless of what currently has
    // focus (reaction buttons, controls) or what stops propagation on the way up
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // `scrollTo` emits 'select' synchronously, which would echo straight back into
  // `navigate` and run the whole onChange side-effect chain a second time.
  const syncingRef = useRef(false);
  const handleSlideChange = (slideIndex: number) => {
    if (!syncingRef.current) navigate?.(slideIndex);
  };

  const followIndex = (api: EmblaCarouselType) => {
    syncingRef.current = true;
    // A slide added in the same commit as the index that names it is not embla's yet, and its
    // own reinit would announce the old slide and write it back through `navigate`.
    if (index >= api.slideNodes().length && index < images.length)
      api.reInit({ startIndex: index });
    else if (api.selectedScrollSnap() !== index) api.scrollTo(index);
    syncingRef.current = false;
  };

  // The provider announces embla's start slide right after handing it over, so an index that moved
  // after mount (a cached branch) has to be followed first, or that announcement writes the old one back.
  const handleSetEmbla = (api: EmblaCarouselType) => {
    emblaRef.current = api;
    followIndex(api);
    setEmbla(api);
  };

  useEffect(() => {
    if (embla) followIndex(embla);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- not on every render
  }, [embla, index, images.length]);

  // The URL replace and the incoming neighbor's full-size decode hang off the
  // settled index rather than the live one — landing either mid-transform is
  // what makes the swipe stutter on mobile. Embla emits 'settle' once the
  // animation is done AND the finger is up.
  const [settledIndex, setSettledIndex] = useState(index);
  // The hat is drawn in a layer outside embla's clipping viewport, so it cannot ride a moving slide.
  const [hatLayer, setHatLayer] = useState<HTMLDivElement | null>(null);
  const [moving, setMoving] = useState(false);
  const onSettleRef = useRef(onSettle);
  onSettleRef.current = onSettle;

  useEffect(() => {
    if (!embla) return;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const commit = () => {
      if (fallback) {
        clearTimeout(fallback);
        fallback = undefined;
      }
      const current = embla.selectedScrollSnap();
      setMoving(false);
      setSettledIndex(current);
      onSettleRef.current?.(current);
    };

    // 'settle' only fires from the animation loop, so anything that destroys the
    // engine mid-flight swallows it — including `loadMore` appending slides,
    // which trips embla's own container MutationObserver into a reInit. Without
    // a fallback the URL would just silently stop tracking the visible image.
    const armFallback = () => {
      if (fallback) clearTimeout(fallback);
      fallback = setTimeout(commit, SETTLE_FALLBACK_MS);
    };

    const startMoving = () => setMoving(true);

    embla
      .on('settle', commit)
      .on('reInit', commit)
      .on('select', armFallback)
      .on('scroll', startMoving);
    return () => {
      if (fallback) clearTimeout(fallback);
      embla
        .off('settle', commit)
        .off('reInit', commit)
        .off('select', armFallback)
        .off('scroll', startMoving);
    };
  }, [embla]);

  const ref = useResizeObserver<HTMLDivElement>(() => {
    embla?.reInit();
  });

  if (!images.length) return null;

  return (
    <div ref={ref} className="relative flex min-h-0 flex-1 items-stretch justify-stretch">
      <Embla
        withControls={canNavigate}
        className="flex-1"
        onSlideChange={handleSlideChange}
        setEmbla={handleSetEmbla}
        startIndex={startIndexRef.current}
        loop={loop}
        watchDrag={canNavigate && watchTouchDrag}
        withKeyboardEvents={false}
      >
        {/* pan-y keeps vertical page scrolling native while horizontal drags go to embla */}
        <Embla.Viewport className="h-full touch-pan-y">
          <Embla.Container className="flex h-full">
            {images.map((image, i) => (
              <Embla.Slide key={image.id} index={i} className="flex-[0_0_100%]">
                {/* function child opts out of Embla's own in-view gating — adjacency
                    is the gate here, so a neighbor is painted before the drag reveals it.
                    Neighbors key off the settled index so a new full-size decode never
                    starts mid-swipe. While a settle is outstanding the next slide along
                    isn't mounted yet, so a drag started in that window reveals it late;
                    the fallback timer above bounds how long that can last. */}
                {() =>
                  (i === index || isAdjacent(i, settledIndex, images.length, loop)) && (
                    <ImageContent
                      image={image}
                      active={index === i}
                      hatLayer={index === i ? hatLayer : null}
                      hatHidden={moving}
                      {...connect}
                      videoRef={index === i ? videoRef : undefined}
                    />
                  )
                }
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
      {/* Not clipped like the viewport, so a hat can hang past the picture's corner. */}
      <div ref={setHatLayer} className="pointer-events-none absolute inset-0 isolate" />
    </div>
  );
}

function ImageContent({
  image,
  videoRef,
  active = true,
  hatLayer,
  hatHidden,
  ...connect
}: {
  image: ImageProps;
  active?: boolean;
  hatLayer: HTMLElement | null;
  hatHidden: boolean;
} & ConnectProps &
  ImageDetailCarouselProps) {
  const [defaultMuted, setDefaultMuted] = useLocalStorage({
    getInitialValueInEffect: false,
    key: 'detailView_defaultMuted',
    defaultValue: true,
  });
  const features = useFeatureFlags();

  const imageHeight = image?.height ?? 1200;
  const imageWidth = image?.width ?? 1200;

  const { setRef, height, width } = useAspectRatioFit({
    height: imageHeight,
    width: imageWidth,
  });

  const isVideo = image?.type === 'video';

  // dragstart carries no pointerType, and android chrome fires it for a long-press
  // drag — leaving that one to embla keeps the touch swipe as `watchTouchDrag` has it
  const pointerType = useRef('mouse');

  const handleDragStart = (event: React.DragEvent) => {
    if (pointerType.current !== 'mouse') return;
    const media = event.target;
    if (!(media instanceof HTMLImageElement) && !(media instanceof HTMLVideoElement)) return;
    allowNativeDragStart(event);
    setMediaDragData(event.dataTransfer, {
      url: media.currentSrc || media.src,
      mediaId: image.id,
      type: isVideo ? 'video' : 'image',
    });
  };

  return (
    <ImageGuardContent image={image} {...connect}>
      {(safe) => (
        <div
          ref={setRef}
          onPointerDownCapture={(event) => (pointerType.current = event.pointerType)}
          onDragStartCapture={handleDragStart}
          className="relative flex size-full items-center justify-center"
        >
          {!safe && width && height ? (
            <div
              className="relative flex max-h-full max-w-full flex-1"
              style={{
                maxHeight: height > 0 ? height : undefined,
                maxWidth: width > 0 ? width : undefined,
                aspectRatio: width > 0 ? `${width}/${height}` : undefined,
              }}
            >
              <MediaHash {...image} />
            </div>
          ) : (
            <EdgeMedia
              // `src`, `name`, `type`, `anim` and `original`: the props that shape the request,
              // shared with the shell's preload of this image (see `image-detail-main-media`) so
              // the two cannot ask for different URLs.
              {...imageDetailMediaProps(image)}
              alt={image.name ?? undefined}
              imageId={image.id}
              className={`max-h-full w-auto max-w-full ${!safe ? 'invisible' : ''}`}
              wrapperProps={{
                className: `flex items-center justify-center max-h-full w-auto max-w-full ${
                  !safe ? 'invisible' : ''
                }`,
                style: {
                  aspectRatio: (image?.width ?? 0) / (image?.height ?? 0),
                },
              }}
              // No `width`: EdgeImage turns one into an inline `maxWidth` that beats `max-w-full`,
              // and the aspect-ratio wrapper then clips the image's height. A `width` would also
              // change the URL, which `imageDetailMediaProps` owns.
              html5Controls={
                active && (features.nativeVideoControls || shouldDisplayHtmlControls(image))
              }
              muted={defaultMuted}
              onMutedChange={(isMuted) => {
                setDefaultMuted(isMuted);
              }}
              videoRef={videoRef}
              youtubeVideoId={
                image.type === 'video' && image.metadata
                  ? (image.metadata as VideoMetadata)?.youtubeVideoId
                  : undefined
              }
              vimeoVideoId={
                image.type === 'video' && image.metadata
                  ? (image.metadata as VideoMetadata)?.vimeoVideoId
                  : undefined
              }
              controls={active}
              videoProps={{
                autoPlay: active,
                // A slide mid-transition is still in view, which the player's own in-view check
                // reads as a reason to play.
                standby: !active,
              }}
            />
          )}
          <DrawnMediaHat
            imageId={image.id}
            decoration={image.eventDecoration}
            layer={hatLayer}
            hidden={hatHidden}
          />
          {safe && <ImageStickerOverlay imageId={image.id} />}
        </div>
      )}
    </ImageGuardContent>
  );
}

export function ImageDetailCarouselIndicators() {
  const { indicators, index, navigate } = useImageDetailCarouselContext();

  if (!indicators) return null;

  return (
    <div className="flex justify-center gap-1">
      {new Array(indicators).map((_, i) => (
        <UnstyledButton
          key={i}
          data-active={i === index || undefined}
          aria-hidden
          tabIndex={-1}
          onClick={() => navigate(i)}
          className={`h-1 max-w-6 flex-1 rounded border border-solid border-gray-4 bg-white shadow-2xl
    ${i !== index ? 'dark:opacity-50' : 'bg-blue-6 dark:bg-white'}`}
        />
      ))}
    </div>
  );
}
