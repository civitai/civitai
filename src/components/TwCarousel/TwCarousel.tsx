import { MantineNumberSize } from '@mantine/core';
import { clamp } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { EmblaCarouselType, EmblaOptionsType, EmblaPluginType } from 'embla-carousel';
import useEmblaCarousel from 'embla-carousel-react';
import { Children, useCallback, useEffect, useRef, useState } from 'react';

export interface CarouselProps extends React.HTMLProps<HTMLDivElement> {
  /** <Carousel.Slide /> components */
  children?: React.ReactNode;

  /** Called when next slide is shown */
  onNextSlide?: () => void;

  /** Called when previous slider is shown */
  onPreviousSlide?: () => void;

  /** Called with slide index when slide changes */
  onSlideChange?: (index: number) => void;

  /** Get embla API as ref */
  getEmblaApi?: (embla: EmblaCarouselType) => void;

  /** Props passed down to next control */
  nextControlProps?: React.ComponentPropsWithoutRef<'button'>;

  /** Props passed down to previous control */
  previousControlProps?: React.ComponentPropsWithoutRef<'button'>;

  /** Controls size of the next and previous controls, `26` by default */
  controlSize?: React.CSSProperties['width'];

  /** Controls position of the next and previous controls, key of `theme.spacing` or any valid CSS value, `'sm'` by default */
  controlsOffset?: MantineNumberSize;

  /** Controls slide width based on viewport width, `'100%'` by default */
  slideSize?: string | number;

  /** Key of theme.spacing or number to set gap between slides */
  slideGap?: MantineNumberSize;

  /** Determines type of queries used for responsive styles, `'media'` by default */
  type?: 'media' | 'container';

  /** Slides container `height`, required for vertical orientation */
  height?: React.CSSProperties['height'];

  /** Determines how slides will be aligned relative to the container. Use number between 0-1 to align slides based on percentage, where 0.5 is 50%, `'center'` by default */
  align?: 'start' | 'center' | 'end';

  /** Number of slides that will be scrolled with next/previous buttons, `1` by default */
  slidesToScroll?: number | 'auto';

  /** Determines whether gap between slides should be treated as part of the slide size, `true` by default */
  includeGapInSize?: boolean;

  /** Determines whether the carousel can be scrolled with mouse and touch interactions, `true` by default */
  draggable?: boolean;

  /** Determines whether momentum scrolling should be enabled, `false` by default */
  dragFree?: boolean;

  /** Enables infinite looping. `true` by default, automatically falls back to `false` if slide content isn't enough to loop. */
  loop?: boolean;

  /** Adjusts scroll speed when triggered by any of the methods. Higher numbers enables faster scrolling. */
  speed?: number;

  /** Index of initial slide */
  initialSlide?: number;

  /** Choose a fraction representing the percentage portion of a slide that needs to be visible in order to be considered in view. For example, 0.5 equals 50%. */
  inViewThreshold?: number;

  /** Determines whether next/previous controls should be displayed, true by default */
  withControls?: boolean;

  /** Determines whether indicators should be displayed, `false` by default */
  withIndicators?: boolean;

  /** An array of embla plugins */
  plugins?: EmblaPluginType[];

  /** Icon of the next control */
  nextControlIcon?: React.ReactNode;

  /** Icon of the previous control */
  previousControlIcon?: React.ReactNode;

  /** Allow the carousel to skip scroll snaps if it is dragged vigorously. Note that this option will be ignored if the dragFree option is set to `true`, `false` by default */
  skipSnaps?: boolean;

  /** Clear leading and trailing empty space that causes excessive scrolling. Use `trimSnaps` to only use snap points that trigger scrolling or keepSnaps to keep them. */
  containScroll?: false | 'trimSnaps' | 'keepSnaps';

  /** Determines whether arrow key should switch slides, `true` by default */
  withKeyboardEvents?: boolean;
}

export function TwCarousel({
  controlSize = 26,
  controlsOffset = 'sm',
  slideSize = '100%',
  slideGap = 0,
  align = 'center',
  slidesToScroll = 1,
  includeGapInSize = true,
  draggable = true,
  dragFree = false,
  loop = false,
  speed = 25,
  initialSlide = 0,
  inViewThreshold = 0,
  withControls = true,
  withIndicators = false,
  skipSnaps = false,
  containScroll = false,
  withKeyboardEvents = true,
  type = 'media',
  plugins,
  getEmblaApi,
  onSlideChange,
  onPreviousSlide,
  onNextSlide,
  children,
  height,
  nextControlIcon,
  nextControlProps,
  previousControlIcon,
  previousControlProps,
  ...props
}: CarouselProps) {
  const styleRef = useRef<Record<string, unknown> | null>(null);

  const [emblaRefElement, embla] = useEmblaCarousel(
    {
      startIndex: initialSlide,
      loop,
      align,
      slidesToScroll,
      watchDrag: draggable,
      dragFree,
      duration: speed,
      inViewThreshold,
      skipSnaps,
      containScroll,
    },
    plugins
  );

  const [selected, setSelected] = useState(0);
  const [slidesCount, setSlidesCount] = useState(0);

  const handleScroll = useCallback((index: number) => embla && embla.scrollTo(index), [embla]);

  const handleSelect = useCallback(() => {
    if (!embla) {
      return;
    }
    const slide = embla.selectedScrollSnap();
    setSelected(slide);
    slide !== selected && onSlideChange?.(slide);
  }, [embla, setSelected, onSlideChange, selected]);

  const handlePrevious = useCallback(() => {
    embla?.scrollPrev();
    onPreviousSlide?.();
  }, [embla]);

  const handleNext = useCallback(() => {
    embla?.scrollNext();
    onNextSlide?.();
  }, [embla]);

  const handleKeydown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (withKeyboardEvents) {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          handleNext();
        }

        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          handlePrevious();
        }
      }
    },
    [embla]
  );

  useEffect(() => {
    if (embla) {
      getEmblaApi?.(embla);
      handleSelect();
      setSlidesCount(embla.scrollSnapList().length);
      embla.on('select', handleSelect);

      return () => {
        embla.off('select', handleSelect);
      };
    }

    return undefined;
  }, [embla, slidesToScroll, handleSelect]);

  useEffect(() => {
    if (embla) {
      embla.reInit();
      setSlidesCount(embla.scrollSnapList().length);
      setSelected((currentSelected) =>
        clamp(currentSelected, 0, Children.toArray(children).length - 1)
      );
    }
  }, [Children.toArray(children).length, slidesToScroll]);

  const canScrollPrev = embla?.canScrollPrev() || false;
  const canScrollNext = embla?.canScrollNext() || false;

  if (!styleRef.current) {
    styleRef.current = {};
    styleRef.current['--carousel-height'] = typeof height === 'number' ? `${height}px` : height;
    styleRef.current['--carousel-slide-gap'] =
      typeof slideGap === 'number' ? `${slideGap}px` : slideGap;
    styleRef.current['--carousel-slide-size'] =
      typeof slideSize === 'number' ? `${slideSize}px` : slideSize;
  }

  return (
    <div ref={emblaRefElement} className="relative">
      <div
        style={styleRef.current}
        className="grid h-[var(--carousel-height)] auto-cols-[var(--carousel-slide-size)] grid-flow-col gap-[var(--carousel-slide-gap)]"
        onKeyDownCapture={handleKeydown}
      >
        {children}
      </div>
      {withControls && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-between">
          <button
            {...previousControlProps}
            className="pointer-events-auto"
            tabIndex={canScrollPrev ? 0 : -1}
            data-inactive={!canScrollPrev || undefined}
            onClick={handlePrevious}
          >
            <IconChevronLeft />
          </button>
          <button
            {...nextControlProps}
            className="pointer-events-auto"
            tabIndex={canScrollNext ? 0 : -1}
            data-inactive={!canScrollNext || undefined}
            onClick={handleNext}
          >
            <IconChevronRight />
          </button>
        </div>
      )}
    </div>
  );
}

type SlideProps = React.HTMLProps<HTMLDivElement>;
function TwSlide({ children, ...props }: SlideProps) {
  return (
    <div {...props} className="size-full" style={{ transform: 'translate3d(0, 0, 0)' }}>
      {children}
    </div>
  );
}

function TwIndicators({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

TwCarousel.Slide = TwSlide;
