import { CSSProperties, useCallback } from 'react';
import clsx from 'clsx';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import {
  EmblaCarouselProvider,
  EmblaCarouselProviderProps,
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
};

function EmblaCarouselWrapper({
  children,
  className,
  controlSize,
  withIndicators,
  withControls,
  ...rest
}: EmblaCarouselWrapperProps) {
  const nextClick = useEmblaStore((state) => state.nextClick);
  const prevClick = useEmblaStore((state) => state.prevClick);
  const withKeyboardEvents = useEmblaStore((state) => state.withKeyboardEvents);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
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
      {children}
      {withControls && <EmblaControls size={controlSize} />}
      {withIndicators && (
        <EmblaIndicators
          className="absolute inset-x-0 bottom-4 flex justify-center gap-2"
          indicatorClassName="h-[5px] w-[25px] rounded-sm bg-white opacity-60 shadow-sm data-[active]:opacity-100"
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

  return (
    <div className={className} style={{ height, ...style }} {...rest}>
      {children}
    </div>
  );
}

function EmblaSlide({
  children,
  index,
  className,
  ...props
}: React.HTMLProps<HTMLDivElement> & {
  index?: number;
}) {
  const inView = useEmblaStore((state) => (index ? state.slidesInView[index] === true : true));

  return (
    <div {...props} className={clsx('transform-3d', className)}>
      {inView && children}
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

  return (
    <button
      {...props}
      style={style}
      className={clsx(
        'flex size-[var(--control-size)] items-center justify-center rounded-full border-gray-3 bg-white text-black shadow-sm transition-opacity duration-150 hover:opacity-100',
        'opacity-85',
        'dark:opacity-65',
        className
      )}
      type="button"
      tabIndex={(type === 'next' ? canScrollNext : canScrollPrevious) ? 0 : -1}
      onClick={type === 'next' ? nextClick : previousClick}
      data-disabled={type === 'next' ? !canScrollNext : !canScrollPrevious}
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
