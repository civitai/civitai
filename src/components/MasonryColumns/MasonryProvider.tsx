import { Box, BoxProps } from '@mantine/core';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColumnCount } from '~/components/MasonryColumns/masonry.utils';
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
  columnWidth: number;
  maxColumnCount: number;
  gap?: number;
  columnGap?: number;
  rowGap?: number;
  maxSingleColumnWidth?: number;
  children: React.ReactNode;
} & BoxProps;

export function MasonryProvider({
  children,
  columnWidth,
  maxColumnCount,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
  maxSingleColumnWidth = columnWidth,
  ...boxProps
}: Props) {
  // width will be set to the inner width of the element. (clientWidth - paddingX)
  const [width, setWidth] = useState(0);
  const debouncer = useDebouncer(100);
  const containerRef = useResizeObserver<HTMLDivElement>((entry) => {
    debouncer(() => setWidth(entry.contentRect.width));
  });

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      const style = getComputedStyle(node);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setWidth(node.clientWidth - paddingX);
    }
  }, []);

  const [columnCount, combinedWidth] = useColumnCount(
    width,
    columnWidth,
    columnGap,
    maxColumnCount
  );

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
