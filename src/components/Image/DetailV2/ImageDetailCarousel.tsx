import { useLocalStorage } from '@mantine/hooks';
import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
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
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import type { EmblaCarouselType } from 'embla-carousel';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';

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

// Touch and pen drags navigate; mouse drags don't, so click-dragging an image on
// desktop still does nothing. At module scope so the body is identical every
// render — embla compares function options by source string.
function watchTouchDrag(
  _emblaApi: EmblaCarouselType,
  event: TouchEvent | MouseEvent | PointerEvent
) {
  // embla binds touchstart/mousedown today; the pointerType branch keeps this
  // correct if it ever moves to pointer events
  if ('pointerType' in event) return event.pointerType !== 'mouse';
  return event.type.startsWith('touch');
}

export function ImageDetailCarousel({
  images,
  videoRef,
  connect,
  index,
  canNavigate,
  navigate,
  next,
  previous,
}: ImageDetailCarouselProps & {
  images: ImageProps[];
  index: number;
  navigate?: (index: number) => void;
  next: () => void;
  previous: () => void;
  canNavigate: boolean;
}) {
  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);
  const emblaRef = useRef<EmblaCarouselType | null>(null);
  const handleSetEmbla = (api: EmblaCarouselType) => {
    emblaRef.current = api;
    setEmbla(api);
  };

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

  useEffect(() => {
    if (!embla || embla.selectedScrollSnap() === index) return;
    syncingRef.current = true;
    embla.scrollTo(index);
    syncingRef.current = false;
  }, [embla, index]);

  const ref = useResizeObserver<HTMLDivElement>(() => {
    embla?.reInit();
  });

  if (!images.length) return null;

  return (
    <div ref={ref} className="flex min-h-0 flex-1 items-stretch justify-stretch">
      <Embla
        withControls={canNavigate}
        className="flex-1"
        onSlideChange={handleSlideChange}
        setEmbla={handleSetEmbla}
        startIndex={startIndexRef.current}
        loop
        watchDrag={canNavigate && watchTouchDrag}
        withKeyboardEvents={false}
      >
        {/* pan-y keeps vertical page scrolling native while horizontal drags go to embla */}
        <Embla.Viewport className="h-full touch-pan-y">
          <Embla.Container className="flex h-full">
            {images.map((image, i) => (
              <Embla.Slide key={image.id} index={i} className="flex-[0_0_100%]">
                {/* function child opts out of Embla's own in-view gating — adjacency
                    is the gate here, so a neighbor is painted before the drag reveals it */}
                {() =>
                  isAdjacent(i, index, images.length) && (
                    <ImageContent
                      image={image}
                      active={index === i}
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
    </div>
  );
}

// the carousel loops, so the neighbors of the first/last slide wrap around
function isAdjacent(i: number, index: number, length: number) {
  if (length < 2) return i === index;
  const distance = Math.abs(i - index);
  return Math.min(distance, length - distance) <= 1;
}

function ImageContent({
  image,
  videoRef,
  active = true,
  ...connect
}: { image: ImageProps; active?: boolean } & ConnectProps & ImageDetailCarouselProps) {
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

  return (
    <ImageGuardContent image={image} {...connect}>
      {(safe) => (
        <div ref={setRef} className="relative flex size-full items-center justify-center">
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
              src={image.url}
              name={image.name ?? image.id.toString()}
              alt={image.name ?? undefined}
              type={image.type}
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
              // width={!isVideo ? undefined : 450} // Leave as undefined to get original size
              // `anim` and `original` feed the CDN URL — an inactive slide has to
              // request the same URL the active one will, or it warms nothing
              anim
              quality={90}
              original={isVideo ? true : undefined}
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
              }}
            />
          )}
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
