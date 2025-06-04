import type { BoxProps } from '@mantine/core';
import { Box } from '@mantine/core';
import React, { createContext, useContext, useMemo, useState } from 'react';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useDebouncer } from '~/utils/debouncer';

export type MasonryContextState = {
  columnWidth: number;
  columnGap: number;
  rowGap: number;
  maxColumnCount: number;
  maxSingleColumnWidth?: number;
  columnCount: number;
  combinedWidth: number;
};

const MasonryContext = createContext<MasonryContextState | null>(null);
export const useMasonryContext = () => {
  const context = useContext(MasonryContext);
  if (!context) throw new Error('MasonryContext not in tree');
  return context;
};

type Props = {
  columnWidth?: number;
  maxColumnCount?: number;
  gap?: number;
  columnGap?: number;
  rowGap?: number;
  maxSingleColumnWidth?: number;
  children: React.ReactNode;
} & BoxProps;

export function MasonryProvider({
  children,
  columnWidth = 320,
  maxColumnCount = 7,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
  maxSingleColumnWidth = 450,
  ...boxProps
}: Props) {
  // width will be set to the inner width of the element. (clientWidth - paddingX)
  const [width, setWidth] = useState(0);
  const debouncer = useDebouncer(100);
  const containerRef = useResizeObserver<HTMLDivElement>((entry) => {
    debouncer(() => setWidth(entry.contentRect.width));
  });

  useIsomorphicLayoutEffect(() => {
    const node = containerRef.current;
    if (node) {
      const style = getComputedStyle(node);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setWidth(node.clientWidth - paddingX);
    }
  }, []);

  const [columnCount, combinedWidth] = useMemo(() => {
    if (width === 0) return [0, 0];
    const gap = 16;
    const count = Math.min(Math.floor((width + gap) / (columnWidth + gap)), maxColumnCount) || 1;
    const combinedWidth = count * columnWidth + (count - 1) * gap;
    return [count, combinedWidth];
  }, [width, columnWidth, maxColumnCount]);

  return (
    <MasonryContext.Provider
      value={{
        columnWidth,
        columnGap,
        rowGap,
        maxColumnCount,
        maxSingleColumnWidth,
        columnCount,
        combinedWidth,
      }}
    >
      <Box ref={containerRef} {...boxProps}>
        {children}
      </Box>
    </MasonryContext.Provider>
  );
}
