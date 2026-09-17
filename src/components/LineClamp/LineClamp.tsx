import type { TextProps } from '@mantine/core';
import { Text } from '@mantine/core';
import type { Key } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { findNearestAncestorWithProps } from '~/utils/html-helpers';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useMergedRef } from '@mantine/hooks';

type LineClampProps = TextProps & {
  children: React.ReactNode;
  id?: Key;
  lineClamp?: number;
};

export const LineClamp = forwardRef<
  HTMLDivElement,
  LineClampProps & { variant?: 'inline' | 'block' }
>(({ variant = 'inline', ...props }, ref) => {
  return variant === 'inline' ? (
    <LineClampInline {...props} ref={ref} />
  ) : (
    <LineClampBlock {...props} />
  );
});

LineClamp.displayName = 'LineClamp';

function useClamped<T extends HTMLElement>(children: React.ReactNode, showMore: boolean) {
  const [clamped, setClamped] = useState(false);
  // Expanded text is never taller than its box, so measuring then would hide "Show less".
  const measure = (element: HTMLElement | null) => {
    if (!element || showMore) return;
    setClamped(element.clientHeight < element.scrollHeight);
  };

  const ref = useResizeObserver<T>((entry) => measure(entry.target as HTMLElement));

  useEffect(() => {
    measure(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  return { ref, clamped };
}

const LineClampInline = forwardRef<HTMLDivElement, LineClampProps>(
  ({ children, lineClamp = 3, className, id, variant, ...props }, ref) => {
    const [showMore, setShowMore] = useState(false);
    const backgroundColorRef = useRef<string | null>(null);
    const { ref: resizeObserverRef, clamped } = useClamped<HTMLDivElement>(children, showMore);

    const mergedRef = useMergedRef(resizeObserverRef, ref);

    function toggleShowMore() {
      setShowMore((s) => !s);
    }

    if (clamped && !backgroundColorRef.current)
      backgroundColorRef.current =
        findNearestAncestorWithProps(resizeObserverRef.current, (elem) => {
          const bg = getComputedStyle(elem).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        }) ?? null;

    const style: Record<string, unknown> = {};
    if (backgroundColorRef.current) style['--bg-ancestor'] = backgroundColorRef.current;

    return (
      <Text
        id={id}
        ref={mergedRef}
        component="div"
        lineClamp={!showMore ? lineClamp : undefined}
        {...props}
        className={clsx('relative break-words', className)}
      >
        {children}
        {clamped && !showMore && (
          <span
            className="absolute bottom-0 right-0 flex select-none items-end bg-[--bg-ancestor] before:absolute before:inset-y-0 before:-left-8 before:w-8 before:bg-gradient-to-r before:from-transparent before:to-[--bg-ancestor]"
            style={style}
          >
            <span className="mr-1 tracking-wide">...</span>
            <Text
              c="blue.4"
              className="cursor-pointer text-[length:inherit]"
              onClick={toggleShowMore}
              span
            >
              Show more
            </Text>
          </span>
        )}
        {clamped && showMore && (
          <Text
            c="blue.4"
            className="ml-1 cursor-pointer select-none text-[length:inherit]"
            onClick={toggleShowMore}
            span
          >
            Show less
          </Text>
        )}
      </Text>
    );
  }
);

LineClampInline.displayName = 'LineClampInline';

export function LineClampBlock({
  children,
  lineClamp = 3,
  ...props
}: Omit<LineClampProps, 'variant'>) {
  const [showMore, setShowMore] = useState(false);
  const { ref, clamped } = useClamped<HTMLDivElement>(children, showMore);

  return (
    <>
      <Text component="div" ref={ref} lineClamp={!showMore ? lineClamp : undefined} {...props}>
        {children}
      </Text>
      {clamped && (
        <div className="flex justify-start">
          <Text
            c="blue.4"
            className="cursor-pointer text-sm"
            onClick={() => setShowMore(!showMore)}
            span
          >
            {showMore ? 'Show less' : 'Show more'}
          </Text>
        </div>
      )}
    </>
  );
}
