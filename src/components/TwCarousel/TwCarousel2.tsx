import { EmblaCarouselType, EmblaOptionsType, EmblaPluginType } from 'embla-carousel';
import useEmblaCarousel from 'embla-carousel-react';
import { createContext, useCallback, useEffect, useState } from 'react';

// Example: https://www.embla-carousel.com/examples/predefined/#lazy-load

type CarouselState = {
  canScrollNext: boolean;
  canScrollPrevious: boolean;
  nextClick: () => void;
  previousClick: () => void;
  emblaApi: EmblaCarouselType | undefined;
};
const CarouselContext = createContext<CarouselState | null>(null);

export function TwCarousel({
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
  const [emblaRef, emblaApi] = useEmblaCarousel(
    {
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
    },
    plugins
  );
  const [slidesInView, setSlidesInView] = useState<number[]>([]);
  const [canScrollNext, setCanScrollNext] = useState(true);
  const [canScrollPrevious, setCanScrollPrevious] = useState(true);

  const onSelect = useCallback((emblaApi: EmblaCarouselType) => {
    setCanScrollNext(!emblaApi.canScrollPrev());
    setCanScrollPrevious(!emblaApi.canScrollNext());
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
    emblaApi.on('reInit', updateSlidesInView);
    emblaApi.on('reInit', onSelect).on('select', onSelect);
  }, [emblaApi, updateSlidesInView, onSelect]);

  return (
    <CarouselContext.Provider
      value={{ canScrollNext, canScrollPrevious, emblaApi, nextClick, previousClick }}
    >
      <div className="embla">
        <div className="embla-viewport" ref={emblaRef}>
          <div className="embla-container">{children}</div>
        </div>
        <div className="embla-controls">
          <div className="embla-buttons">
            <button onClick={previousClick}>Previous</button>
            <button onClick={nextClick}>Next</button>
          </div>
        </div>
      </div>
    </CarouselContext.Provider>
  );
}
