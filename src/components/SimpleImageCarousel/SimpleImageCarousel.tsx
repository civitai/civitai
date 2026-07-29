import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type ViewportSwipeHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
};

type SimpleCarouselContextType = {
  currentIndex: number;
  total: number;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  canScrollNext: boolean;
  canScrollPrev: boolean;
  swipeHandlers: ViewportSwipeHandlers | null;
};

const SimpleCarouselContext = createContext<SimpleCarouselContextType | null>(null);

function useSimpleCarousel() {
  const context = useContext(SimpleCarouselContext);
  if (!context) {
    throw new Error('useSimpleCarousel must be used within a SimpleImageCarousel');
  }
  return context;
}

type SimpleImageCarouselProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  loop?: boolean;
  total: number;
  initialIndex?: number;
  /**
   * Fired (from a commit effect, not during render) whenever the active slide
   * changes — including the initial mount. Used by the gallery's lazy per-post
   * carousel to prefetch the tail on approach.
   */
  onIndexChange?: (index: number) => void;
  /**
   * Opt-in horizontal drag on the viewport. Off by default: the gallery feed
   * mounts hundreds of these at once, so no card pays for touch handling unless
   * the viewer asked for it (`swipeGalleryCards` user setting).
   */
  enableSwipe?: boolean;
};

/** Horizontal travel (px) before a gesture is claimed as a swipe rather than a page scroll. */
const AXIS_LOCK_THRESHOLD = 10;
/** Horizontal travel (px) required to actually change slides. */
const SWIPE_DISTANCE_THRESHOLD = 45;

export function SimpleImageCarousel({
  children,
  className,
  style,
  loop = false,
  total,
  initialIndex = 0,
  onIndexChange,
  enableSwipe = false,
}: SimpleImageCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Notify on index change (and initial mount) from an effect so callers can
  // trigger side effects (a tail fetch) without violating render purity. Ref-held
  // so a changing `onIndexChange` identity doesn't refire for the same index.
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  useEffect(() => {
    onIndexChangeRef.current?.(currentIndex);
  }, [currentIndex]);

  const canScrollNext = loop || currentIndex < total - 1;
  const canScrollPrev = loop || currentIndex > 0;

  const next = useCallback(() => {
    setCurrentIndex((prev) => {
      if (prev >= total - 1) {
        return loop ? 0 : prev;
      }
      return prev + 1;
    });
  }, [total, loop]);

  const prev = useCallback(() => {
    setCurrentIndex((prev) => {
      if (prev <= 0) {
        return loop ? total - 1 : prev;
      }
      return prev - 1;
    });
  }, [total, loop]);

  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < total) {
        setCurrentIndex(index);
      }
    },
    [total]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        prev();
      }
    },
    [next, prev]
  );

  const swipeHandlers = useSwipeHandlers({
    enabled: enableSwipe && total > 1,
    next,
    prev,
    canScrollNext,
    canScrollPrev,
  });

  const contextValue = useMemo(
    () => ({ currentIndex, total, next, prev, goTo, canScrollNext, canScrollPrev, swipeHandlers }),
    [currentIndex, total, next, prev, goTo, canScrollNext, canScrollPrev, swipeHandlers]
  );

  return (
    <SimpleCarouselContext.Provider value={contextValue}>
      <div
        className={clsx('relative', className)}
        style={style}
        onKeyDownCapture={handleKeyDown}
        tabIndex={0}
      >
        {children}
      </div>
    </SimpleCarouselContext.Provider>
  );
}

// Pointer capture throws when the id isn't an active pointer (a released touch,
// a synthesized event). Losing capture only costs us a gesture, so never let it
// take down the render.
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // no capture — the gesture still tracks via events on this element
  }
}

function releasePointer(element: Element, pointerId: number) {
  try {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // already released
  }
}

/**
 * Pointer-event swipe. Deliberately library-free and allocation-light: one ref
 * holds the whole gesture, and nothing is subscribed while the finger is down.
 *
 * The gesture locks to an axis on first movement — horizontal drives the
 * carousel, vertical is released back to the browser so the feed still scrolls.
 * A completed horizontal drag swallows the click that follows it, otherwise
 * lifting your finger would also open the image detail dialog behind the slide.
 */
function useSwipeHandlers({
  enabled,
  next,
  prev,
  canScrollNext,
  canScrollPrev,
}: {
  enabled: boolean;
  next: () => void;
  prev: () => void;
  canScrollNext: boolean;
  canScrollPrev: boolean;
}): ViewportSwipeHandlers | null {
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    axis: 'none' | 'horizontal';
  } | null>(null);
  const suppressClick = useRef(false);

  const navRef = useRef({ next, prev, canScrollNext, canScrollPrev });
  navRef.current = { next, prev, canScrollNext, canScrollPrev };

  return useMemo(() => {
    if (!enabled) return null;

    const end = (event: React.PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return null;
      gesture.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      return current;
    };

    return {
      onPointerDown: (event) => {
        // Secondary/right mouse buttons are not gestures.
        if (event.button !== 0) return;
        // A second finger means the user is pinching, not swiping — drop the
        // gesture rather than letting the new pointer hijack it. A primary
        // pointer arriving on top of an existing gesture instead means the last
        // one was stranded (it left the element before we captured it), so this
        // one replaces it.
        if (gesture.current && !event.isPrimary) {
          gesture.current = null;
          return;
        }
        // A drag that never produced a click (touch pointers don't always emit
        // one) must not swallow the next real tap.
        suppressClick.current = false;
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          axis: 'none',
        };
      },
      onPointerMove: (event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (current.axis === 'horizontal') return;

        const dx = Math.abs(event.clientX - current.startX);
        const dy = Math.abs(event.clientY - current.startY);
        if (dx < AXIS_LOCK_THRESHOLD && dy < AXIS_LOCK_THRESHOLD) return;
        if (dy >= dx) {
          // Vertical intent: drop the gesture so the browser scrolls the feed.
          gesture.current = null;
          return;
        }
        current.axis = 'horizontal';
        capturePointer(event.currentTarget, event.pointerId);
      },
      onPointerUp: (event) => {
        const current = end(event);
        if (!current || current.axis !== 'horizontal') return;

        const dx = event.clientX - current.startX;
        // The drag moved far enough to be intentional, so it owns the click that
        // follows regardless of whether we end up changing slides.
        if (Math.abs(dx) >= AXIS_LOCK_THRESHOLD) suppressClick.current = true;
        if (Math.abs(dx) < SWIPE_DISTANCE_THRESHOLD) return;

        const {
          next: goNext,
          prev: goPrev,
          canScrollNext: fwd,
          canScrollPrev: back,
        } = navRef.current;
        if (dx < 0 && fwd) goNext();
        else if (dx > 0 && back) goPrev();
      },
      onPointerCancel: (event) => {
        end(event);
      },
      onClickCapture: (event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }, [enabled]);
}

type SlideProps = {
  children: ReactNode;
  index: number;
  className?: string;
};

function Slide({ children, index, className }: SlideProps) {
  const { currentIndex } = useSimpleCarousel();
  const isActive = currentIndex === index;

  if (!isActive) return null;

  return <div className={clsx('size-full', className)}>{children}</div>;
}

type ControlsProps = {
  size?: number;
};

function Controls({ size = 32 }: ControlsProps) {
  const { total } = useSimpleCarousel();

  if (total <= 1) return null;

  return (
    <>
      <SimpleImageCarousel.Button
        size={size}
        type="previous"
        className="absolute left-3 top-1/2 z-10 -translate-y-1/2"
      >
        <IconChevronLeft size={size / 2} />
      </SimpleImageCarousel.Button>
      <SimpleImageCarousel.Button
        size={size}
        type="next"
        className="absolute right-3 top-1/2 z-10 -translate-y-1/2"
      >
        <IconChevronRight size={size / 2} />
      </SimpleImageCarousel.Button>
    </>
  );
}

type ButtonProps = Omit<React.HTMLProps<HTMLButtonElement>, 'type'> & {
  type: 'next' | 'previous';
  size?: number;
};

function Button({ children, type, className, size = 32, style, ...props }: ButtonProps) {
  const { next, prev, canScrollNext, canScrollPrev } = useSimpleCarousel();

  const buttonStyle = {
    '--control-size': `${size}px`,
    ...style,
  } as CSSProperties;

  const disabled = type === 'next' ? !canScrollNext : !canScrollPrev;

  return (
    <button
      {...props}
      style={buttonStyle}
      className={clsx(
        'flex size-[--control-size] items-center justify-center rounded-full bg-white text-black shadow-sm transition-opacity duration-150 hover:opacity-100 data-[disabled]:opacity-25 data-[disabled]:hover:opacity-25',
        'opacity-85',
        'dark:opacity-65',
        className
      )}
      type="button"
      tabIndex={disabled ? -1 : 0}
      onClick={type === 'next' ? next : prev}
      data-disabled={disabled || undefined}
    >
      {children}
    </button>
  );
}

type IndicatorsProps = Omit<React.HTMLProps<HTMLDivElement>, 'children'> & {
  indicatorClassName?: string;
};

function Indicators({ indicatorClassName, className, ...props }: IndicatorsProps) {
  const { total } = useSimpleCarousel();

  if (total <= 1) return null;

  return (
    <div className={className} {...props}>
      {Array.from({ length: total }).map((_, index) => (
        <Indicator key={index} index={index} className={indicatorClassName} />
      ))}
    </div>
  );
}

type IndicatorProps = React.HTMLProps<HTMLButtonElement> & {
  index: number;
};

function Indicator({ index, className, ...props }: IndicatorProps) {
  const { currentIndex, goTo } = useSimpleCarousel();
  const isActive = currentIndex === index;

  return (
    <button
      {...props}
      onClick={() => goTo(index)}
      type="button"
      tabIndex={-1}
      aria-hidden
      data-active={isActive || undefined}
      className={className}
    />
  );
}

type ViewportProps = {
  children: ReactNode;
  className?: string;
};

function Viewport({ children, className }: ViewportProps) {
  const { swipeHandlers } = useSimpleCarousel();

  return (
    <div
      // `pan-y` is what makes the horizontal drag reach us at all — without it the
      // browser claims the gesture for scrolling and no pointermove lands.
      // `pinch-zoom` is kept so opting into swipe doesn't cost you zooming an image.
      className={clsx(
        'relative overflow-hidden',
        swipeHandlers && 'touch-pan-y touch-pinch-zoom',
        className
      )}
      {...swipeHandlers}
    >
      {children}
    </div>
  );
}

type ContainerProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

function Container({ children, className, style }: ContainerProps) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

SimpleImageCarousel.Slide = Slide;
SimpleImageCarousel.Controls = Controls;
SimpleImageCarousel.Button = Button;
SimpleImageCarousel.Indicators = Indicators;
SimpleImageCarousel.Indicator = Indicator;
SimpleImageCarousel.Viewport = Viewport;
SimpleImageCarousel.Container = Container;
