import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import type { EmblaCarouselProviderProps } from '~/components/EmblaCarousel/EmblaCarouselProvider';
import { HatLayerHost, useHatLayer } from '~/components/Cosmetics/EventDecoration/HatLayer';
import {
  EmblaCarouselProvider,
  useEmblaStore,
} from '~/components/EmblaCarousel/EmblaCarouselProvider';

// Example: https://www.embla-carousel.com/examples/predefined/#lazy-load

export type EmblaCarouselProps = EmblaCarouselProviderProps & EmblaCarouselWrapperProps;

export function Embla({
  children,
  className,
  style,
  withControls,
  withIndicators,
  controlSize,
  hatLayer,
  ...args
}: EmblaCarouselProps) {
  return (
    <EmblaCarouselProvider {...args}>
      <EmblaCarouselWrapper
        className={className}
        style={style}
        withControls={withControls}
        withIndicators={withIndicators}
        controlSize={controlSize}
        hatLayer={hatLayer}
      >
        {children}
      </EmblaCarouselWrapper>
    </EmblaCarouselProvider>
  );
}

type EmblaCarouselWrapperProps = {
  children: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  controlSize?: number;
  withIndicators?: boolean;
  withControls?: boolean;
  hatLayer?: boolean;
};

// Fallback for when no settle event arrives; the hats settle on their slides at most this long after.
export const HAT_SETTLE_FALLBACK_MS = 800;

function EmblaHatMotion() {
  const emblaApi = useEmblaStore((state) => state.emblaApi);
  const hatLayer = useHatLayer();
  const moved = hatLayer?.moved;
  const remeasure = hatLayer?.remeasure;
  useEffect(() => {
    if (!emblaApi || !moved || !remeasure) return;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(fallback);
      moved(true);
    };
    // Embla moves the slides before it emits `scroll`, so the hats read them where they are drawn.
    const scroll = () => {
      moved(false);
      clearTimeout(fallback);
      fallback = setTimeout(settle, HAT_SETTLE_FALLBACK_MS);
    };
    // A re-init moves the slides without resizing them, so the hats measure again.
    const reInit = () => {
      settle();
      remeasure();
    };
    emblaApi.on('scroll', scroll).on('settle', settle).on('reInit', reInit);
    return () => {
      clearTimeout(fallback);
      emblaApi.off('scroll', scroll).off('settle', settle).off('reInit', reInit);
    };
  }, [emblaApi, moved, remeasure]);
  return null;
}

function EmblaCarouselWrapper({
  children,
  className,
  controlSize,
  withIndicators,
  withControls,
  hatLayer,
  ...rest
}: EmblaCarouselWrapperProps) {
  const nextClick = useEmblaStore((state) => state.nextClick);
  const prevClick = useEmblaStore((state) => state.prevClick);
  const withKeyboardEvents = useEmblaStore((state) => state.withKeyboardEvents);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A hat drawn into the carousel's layer bubbles its keys here; its focus must not scroll away.
      if ((event.target as Element).closest?.('[data-event-decoration="hat"]')) return;
      if (withKeyboardEvents) {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          nextClick();
        }

        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          prevClick();
        }
      }
    },
    [withKeyboardEvents, nextClick, prevClick]
  );

  return (
    <div className={clsx('relative', className)} onKeyDownCapture={handleKeyDown} {...rest}>
      {hatLayer ? (
        <HatLayerHost>
          {children}
          <EmblaHatMotion />
        </HatLayerHost>
      ) : (
        <>
          {children}
          <EmblaHatMotion />
        </>
      )}
      {withControls && <EmblaControls size={controlSize} />}
      {withIndicators && (
        <EmblaIndicators
          className="absolute inset-x-0 bottom-4 flex justify-center gap-2"
          indicatorClassName="h-[5px] w-[25px] rounded-sm bg-white opacity-60 shadow-sm border-none data-[active]:opacity-100"
        />
      )}
    </div>
  );
}

function EmblaViewport({ children, className, ...props }: React.HTMLProps<HTMLDivElement>) {
  const setViewport = useEmblaStore((state) => state.setViewport);

  return (
    <div ref={setViewport} className={clsx('overflow-hidden', className)} {...props}>
      {children}
    </div>
  );
}

function EmblaContainer({ children, className, style, ...rest }: React.HTMLProps<HTMLDivElement>) {
  const height = useEmblaStore((state) => state.initialHeight);
  const emblaApi = useEmblaStore((state) => state.emblaApi);
  const loop = useEmblaStore((state) => state.loop ?? false);
  const canScroll = useEmblaStore((state) => state.canScrollNext || state.canScrollPrev);
  const [shouldDuplicate, setShouldDuplicate] = useState(false);

  // this effect allows us to loop carousels where the content is not enough to allow looping without visible glitches
  useEffect(() => {
    if (emblaApi && loop && !emblaApi.internalEngine().slideLooper.canLoop() && canScroll)
      setShouldDuplicate(true);
  }, [emblaApi, loop, canScroll]);

  return (
    <div className={className} style={{ height, ...style }} {...rest}>
      {children}
      {shouldDuplicate && children}
    </div>
  );
}

function EmblaSlide({
  children,
  index,
  className,
  ...props
}: Omit<React.HTMLProps<HTMLDivElement>, 'children'> & {
  index?: number;
  // A function child receives `inView` so the slide can reserve its size up
  // front (e.g. an aspect-ratio box) while lazy-loading the heavy content only
  // when in view. A plain node keeps the original render-when-in-view behavior.
  children?: React.ReactNode | ((state: { inView: boolean }) => React.ReactNode);
}) {
  const inView = useEmblaStore((state) => (index ? state.slidesInView[index] === true : true));

  return (
    <div {...props} className={clsx('transform-3d', className)}>
      {typeof children === 'function' ? children({ inView }) : inView && children}
    </div>
  );
}

function EmblaControls({ size = 32 }: { size?: number }) {
  return (
    <>
      <Embla.Button
        size={size}
        type="previous"
        className="absolute left-3 top-1/2 -translate-y-1/2"
      >
        <IconChevronLeft size={size / 2} />
      </Embla.Button>
      <Embla.Button size={size} type="next" className="absolute right-3 top-1/2 -translate-y-1/2">
        <IconChevronRight size={size / 2} />
      </Embla.Button>
    </>
  );
}

function EmblaButton({
  children,
  type,
  className,
  size = 32,
  ...props
}: Omit<React.HTMLProps<HTMLButtonElement>, 'type'> & {
  type: 'next' | 'previous';
  size?: number;
}) {
  const nextClick = useEmblaStore((state) => state.nextClick);
  const previousClick = useEmblaStore((state) => state.prevClick);
  const canScrollNext = useEmblaStore((state) => state.canScrollNext);
  const canScrollPrevious = useEmblaStore((state) => state.canScrollPrev);

  const style = {
    '--control-size': `${size}px`,
    ...props.style,
  } as CSSProperties;

  const disabled = (type === 'next' ? !canScrollNext : !canScrollPrevious) ? true : undefined;

  return (
    <button
      {...props}
      style={style}
      className={clsx(
        'flex size-[--control-size] items-center justify-center rounded-full bg-white text-black shadow-md ring-1 ring-black/30 transition-opacity duration-150 hover:opacity-100 data-[disabled]:opacity-25 data-[disabled]:hover:opacity-25',
        'opacity-85',
        'dark:opacity-65',
        className
      )}
      type="button"
      aria-label={props['aria-label'] ?? (type === 'next' ? 'Next image' : 'Previous image')}
      tabIndex={(type === 'next' ? canScrollNext : canScrollPrevious) ? 0 : -1}
      onClick={type === 'next' ? nextClick : previousClick}
      data-disabled={disabled}
    >
      {children}
    </button>
  );
}

function EmblaIndicators({
  indicatorClassName,
  ...props
}: Omit<React.HTMLProps<HTMLDivElement>, 'children'> & {
  indicatorClassName: string;
}) {
  const scrollSnapList = useEmblaStore((state) => state.scrollSnapList);
  return (
    <div {...props}>
      {scrollSnapList.map((_, index) => (
        <EmblaIndicator key={index} index={index} className={indicatorClassName} />
      ))}
    </div>
  );
}

function EmblaIndicator({
  children,
  index,
  ...props
}: React.HTMLProps<HTMLButtonElement> & { index: number }) {
  const emblaApi = useEmblaStore((state) => state.emblaApi);
  const active = useEmblaStore((state) => state.selectedIndex === index || undefined);

  const handleClick = useCallback(() => {
    if (!emblaApi) return;
    emblaApi.scrollTo(index);
  }, [emblaApi, index]);

  return (
    <button
      {...props}
      onClick={handleClick}
      type="button"
      tabIndex={-1}
      aria-hidden
      data-active={active}
    >
      {children}
    </button>
  );
}

Embla.Viewport = EmblaViewport;
Embla.Container = EmblaContainer;
Embla.Slide = EmblaSlide;
Embla.Button = EmblaButton;
Embla.Indicators = EmblaIndicators;
Embla.Indicator = EmblaIndicator;
Embla.Controls = EmblaControls;
