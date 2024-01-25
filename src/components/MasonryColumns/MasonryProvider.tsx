import { Box, BoxProps } from '@mantine/core';
import React, { createContext, useContext, useState } from 'react';
import { getColumnCount } from '~/components/MasonryColumns/masonry.utils';
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
  onResize?: (context: MasonryContextState & { containerWidth: number }) => void;
} & BoxProps;

export function MasonryProvider({
  children,
  columnWidth,
  maxColumnCount,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
  maxSingleColumnWidth = columnWidth,
  onResize,
  ...boxProps
}: Props) {
  const [columnCount, setColumnCount] = useState(0);
  const [combinedWidth, setCombinedWidth] = useState(0);
  const debouncer = useDebouncer(100);

  const containerRef = useResizeObserver((entry) => {
    debouncer(() => {
      const width = entry.contentRect.width;
      const [columnCount, combinedWidth] = getColumnCount(
        width,
        columnWidth,
        columnGap,
        maxColumnCount
      );
      setColumnCount(columnCount);
      setCombinedWidth(combinedWidth);
      onResize?.({
        containerWidth: width,
        columnWidth,
        columnGap,
        rowGap,
        maxColumnCount,
        maxSingleColumnWidth,
        columnCount,
        combinedWidth,
      });
    });
  });

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
