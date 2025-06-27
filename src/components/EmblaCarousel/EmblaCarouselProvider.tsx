import type { EmblaCarouselType, EmblaOptionsType, EmblaPluginType } from 'embla-carousel';
import type { EmblaViewportRefType } from 'embla-carousel-react';
import useEmblaCarousel from 'embla-carousel-react';
import type { CSSProperties } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { removeEmpty } from '~/utils/object-helpers';
import type { StoreApi } from 'zustand';
import { createStore, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// Example: https://www.embla-carousel.com/examples/predefined/#lazy-load

type CarouselState = {
  nextClick: () => void;
  previousClick: () => void;
  setViewport: EmblaViewportRefType;
  emblaApi: EmblaCarouselType | undefined;
};
const CarouselContext = createContext<CarouselState | null>(null);
export function useCarouselContext() {
  const context = useContext(CarouselContext);
  if (!context) throw new Error('missing CarouselProvider');
  return context;
}

export type EmblaCarouselProviderProps = {
  children: React.ReactNode;
  plugins?: EmblaPluginType[];
  onSlideChange?: (index: number) => void;
  setEmbla?: (embla: EmblaCarouselType) => void;
  initialHeight?: CSSProperties['height'];
  withKeyboardEvents?: boolean;
} & EmblaOptionsType;

type EmblaStoreState = {
  emblaApi?: EmblaCarouselType;
  setViewport: EmblaViewportRefType;
  slidesInView: Record<number, true>;
  selectedIndex: number;
  canScrollNext: boolean;
  canScrollPrev: boolean;
  scrollSnapList: number[];
  initialHeight?: CSSProperties['height'];
  withKeyboardEvents: boolean;
  loop?: boolean;
  setSlidesInView: (fn: (indexes: number[]) => number[]) => void;
  setSelectedIndex: (index: number) => void;
  setCanScrollNext: (value: boolean) => void;
  setCanScrollPrev: (value: boolean) => void;
  nextClick: () => void;
  prevClick: () => void;
};
const EmblaStoreContext = createContext<StoreApi<EmblaStoreState> | null>(null);
export function EmblaCarouselProvider({
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
  startIndex = 0,
  watchDrag,
  watchResize,
  watchSlides,
  watchFocus,
  plugins,
  onSlideChange,
  setEmbla,
  initialHeight,
  withKeyboardEvents = true,
}: EmblaCarouselProviderProps) {
  console.log({ align });
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

  const storeRef = useRef<StoreApi<EmblaStoreState> | null>(null);
  if (!storeRef.current)
    storeRef.current = createStore<EmblaStoreState>()(
      immer((set) => ({
        slidesInView: {},
        selectedIndex: startIndex,
        canScrollNext: false,
        canScrollPrev: false,
        scrollSnapList: [],
        initialHeight,
        withKeyboardEvents,
        loop,
        setSlidesInView: (fn) =>
          set((state) => {
            const slidesInView = Object.keys(state.slidesInView).map(Number);
            const indexes = fn(slidesInView);
            for (const index of indexes) {
              if (!state.slidesInView[index]) state.slidesInView[index] = true;
            }
          }),
        setSelectedIndex: (index) =>
          set((state) => {
            state.selectedIndex = index;
          }),
        setCanScrollNext: (value) =>
          set((state) => {
            state.canScrollNext = value;
          }),
        setCanScrollPrev: (value) =>
          set((state) => {
            state.canScrollPrev = value;
          }),
        setViewport,
        nextClick: () => undefined,
        prevClick: () => undefined,
      }))
    );

  const setSlidesInView = storeRef.current.getState().setSlidesInView;
  const onSelect = useCallback((emblaApi: EmblaCarouselType) => {
    onSlideChange?.(emblaApi.selectedScrollSnap());
    if (storeRef.current) {
      storeRef.current.setState({
        canScrollNext: emblaApi.canScrollNext(),
        canScrollPrev: emblaApi.canScrollPrev(),
        selectedIndex: emblaApi.selectedScrollSnap(),
      });
    }
  }, []);

  const onInit = useCallback((emblaApi: EmblaCarouselType) => {
    if (storeRef.current) storeRef.current.setState({ scrollSnapList: emblaApi.scrollSnapList() });
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

  useEffect(() => {
    if (storeRef.current && emblaApi) {
      storeRef.current.setState({
        emblaApi,
        nextClick: () => {
          emblaApi.scrollNext();
        },
        prevClick: () => {
          emblaApi.scrollPrev();
        },
      });
    }
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;

    setEmbla?.(emblaApi);
    updateSlidesInView(emblaApi);
    onSelect(emblaApi);
    onInit(emblaApi);

    emblaApi.on('slidesInView', updateSlidesInView);
    emblaApi.on('reInit', onInit);
    emblaApi.on('reInit', updateSlidesInView);
    emblaApi.on('reInit', onSelect).on('select', onSelect);

    if (initialHeight) storeRef.current?.setState({ initialHeight: undefined });
  }, [emblaApi, updateSlidesInView, onSelect, onInit]);

  return (
    <EmblaStoreContext.Provider value={storeRef.current}>{children}</EmblaStoreContext.Provider>
  );
}

export function useEmblaStore<T>(selector: (state: EmblaStoreState) => T) {
  const store = useContext(EmblaStoreContext);
  if (!store) throw new Error('Missing EmblaStoreProvider');

  return useStore(store, selector);
}
