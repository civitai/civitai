import { EmblaCarouselType, EmblaOptionsType, EmblaPluginType } from 'embla-carousel';
import useEmblaCarousel, { EmblaViewportRefType } from 'embla-carousel-react';
import { CSSProperties, createContext, useCallback, useContext, useEffect, useState } from 'react';
import clsx from 'clsx';
import { removeEmpty } from '~/utils/object-helpers';

// Example: https://www.embla-carousel.com/examples/predefined/#lazy-load

type CarouselState = {
  canScrollNext: boolean;
  canScrollPrevious: boolean;
  nextClick: () => void;
  previousClick: () => void;
  setViewport: EmblaViewportRefType;
  emblaApi: EmblaCarouselType | undefined;
  selectedIndex: number;
  slidesInView: number[];
  scrollSnaps: number[];
};
const CarouselContext = createContext<CarouselState | null>(null);
export function useCarouselContext() {
  const context = useContext(CarouselContext);
  if (!context) throw new Error('missing CarouselProvider');
  return context;
}

export function EmblaCarousel({
  children,
  align,
  axis,
  container,
  slides,
  containScroll,
  direction,
  slidesToScroll,
  dragFree,
  dragThreshold,
  inViewThreshold,
  loop,
  skipSnaps,
  duration,
  startIndex,
  watchDrag,
  watchResize,
  watchSlides,
  watchFocus,
  plugins,
}: {
  children: React.ReactNode;

  plugins?: EmblaPluginType[];
} & EmblaOptionsType) {
  const [setViewport, emblaApi] = useEmblaCarousel(
    removeEmpty({
      align,
      axis,
      container,
      slides,
      containScroll,
      direction,
      slidesToScroll,
      dragFree,
      dragThreshold,
      inViewThreshold,
      loop,
      skipSnaps,
      duration,
      startIndex,
      watchDrag,
      watchResize,
      watchSlides,
      watchFocus,
    }),
    plugins
  );
  const [slidesInView, setSlidesInView] = useState<number[]>([]);
  const [canScrollNext, setCanScrollNext] = useState(true);
  const [canScrollPrevious, setCanScrollPrevious] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([]);

  const onSelect = useCallback((emblaApi: EmblaCarouselType) => {
    setCanScrollNext(!emblaApi.canScrollPrev());
    setCanScrollPrevious(!emblaApi.canScrollNext());
    setSelectedIndex(emblaApi.selectedScrollSnap());
  }, []);

  const onInit = useCallback((emblaApi: EmblaCarouselType) => {
    setScrollSnaps(emblaApi.scrollSnapList());
  }, []);

  const updateSlidesInView = useCallback((emblaApi: EmblaCarouselType) => {
    setSlidesInView((slidesInView) => {
      if (slidesInView.length === emblaApi.slideNodes().length) {
        emblaApi.off('slidesInView', updateSlidesInView);
      }
      const inView = emblaApi.slidesInView().filter((index) => !slidesInView.includes(index));
      return slidesInView.concat(inView);
    });
  }, []);

  const nextClick = useCallback(() => {
    if (!emblaApi) return;
    emblaApi.scrollNext();
  }, [emblaApi]);

  const previousClick = useCallback(() => {
    if (!emblaApi) return;
    emblaApi.scrollPrev();
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;

    updateSlidesInView(emblaApi);
    onSelect(emblaApi);
    emblaApi.on('slidesInView', updateSlidesInView);
    emblaApi.on('reInit', onInit);
    emblaApi.on('reInit', updateSlidesInView);
    emblaApi.on('reInit', onSelect).on('select', onSelect);
  }, [emblaApi, updateSlidesInView, onSelect, onInit]);

  return (
    <CarouselContext.Provider
      value={{
        canScrollNext,
        canScrollPrevious,
        setViewport,
        emblaApi,
        nextClick,
        previousClick,
        selectedIndex,
        slidesInView,
        scrollSnaps,
      }}
    >
      {children}
    </CarouselContext.Provider>
  );
}

function EmblaViewport({
  children,
  height,
  spacing,
  size,
  ...props
}: {
  height: CSSProperties['height'];
  spacing: CSSProperties['gap'];
  size: `${number}%`;
} & Omit<React.HTMLProps<HTMLDivElement>, 'size'>) {
  const { setViewport } = useCarouselContext();
  const style = {
    '--slide-height': `${height}px`,
    '--slide-spacing': spacing,
    '--slide-size': size,
    ...props.style,
  } as CSSProperties;

  return (
    <div ref={setViewport} className="overflow-hidden" {...props} style={style}>
      <div className="ml-[calc(var(--slide-spacing)*-1)] flex touch-pan-y touch-pinch-zoom">
        {children}
      </div>
    </div>
  );
}

function EmblaSlide({
  children,
  index,
  ...props
}: React.HTMLProps<HTMLDivElement> & {
  index: number;
}) {
  const { slidesInView } = useCarouselContext();
  const inView = slidesInView.includes(index);

  return (
    <div
      {...props}
      className="h-[var(--slide-height)] flex-[0_0_var(--slide-size)] pl-[var(--slide-spacing)] transform-3d"
    >
      {inView && children}
    </div>
  );
}

function EmblaButton({
  children,
  type,
  className,
  ...props
}: Omit<React.HTMLProps<HTMLButtonElement>, 'type'> & { type: 'next' | 'previous' }) {
  const { canScrollNext, canScrollPrevious, nextClick, previousClick } = useCarouselContext();

  return (
    <button
      {...props}
      className={clsx('pointer-events-auto', className)}
      type="button"
      tabIndex={(type === 'next' ? canScrollNext : canScrollPrevious) ? 0 : -1}
      onClick={type === 'next' ? nextClick : previousClick}
      data-disabled={type === 'next' ? !canScrollNext : !canScrollPrevious}
    >
      {children}
    </button>
  );
}

function ScrollSnap({
  children,
  index,
  ...props
}: React.HTMLProps<HTMLButtonElement> & { index: number }) {
  const { selectedIndex, emblaApi } = useCarouselContext();

  const handleClick = useCallback(() => {
    if (!emblaApi) return;
    emblaApi.scrollTo(index);
  }, [emblaApi, index]);

  return (
    <button {...props} onClick={handleClick} type="button" data-active={selectedIndex === index}>
      {children}
    </button>
  );
}

EmblaCarousel.Viewport = EmblaViewport;
EmblaCarousel.Slide = EmblaSlide;
EmblaCarousel.Button = EmblaButton;
EmblaCarousel.ScrollSnap = ScrollSnap;
