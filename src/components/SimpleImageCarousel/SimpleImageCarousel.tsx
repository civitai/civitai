import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

type SimpleCarouselContextType = {
  currentIndex: number;
  total: number;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  canScrollNext: boolean;
  canScrollPrev: boolean;
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
};

export function SimpleImageCarousel({
  children,
  className,
  style,
  loop = false,
  total,
  initialIndex = 0,
}: SimpleImageCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

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

  return (
    <SimpleCarouselContext.Provider
      value={{ currentIndex, total, next, prev, goTo, canScrollNext, canScrollPrev }}
    >
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
  return <div className={clsx('relative overflow-hidden', className)}>{children}</div>;
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
