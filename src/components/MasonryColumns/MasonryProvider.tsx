import React, { createContext, useContext } from 'react';

type LayoutState = {
  columnWidth: number;
  columnGap: number;
  rowGap: number;
  maxColumnCount: number;
  maxSingleColumnWidth?: number;
  maxItemHeight?: number;
};

const MasonryContext = createContext<LayoutState | null>(null);
export const useMasonryContext = () => {
  const context = useContext(MasonryContext);
  if (!context) throw new Error('MasonryContext not in tree');
  return context;
};

type Props = {
  columnWidth: number;
  maxColumnCount: number;
  maxItemHeight?: number;
  gap?: number;
  columnGap?: number;
  rowGap?: number;
  maxSingleColumnWidth?: number;
  children: React.ReactNode;
};

export function MasonryProvider({
  children,
  columnWidth,
  maxColumnCount,
  maxItemHeight,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
  maxSingleColumnWidth,
}: Props) {
  return (
    <MasonryContext.Provider
      value={{
        columnWidth,
        columnGap,
        rowGap,
        maxColumnCount,
        maxSingleColumnWidth,
        maxItemHeight,
      }}
    >
      {children}
    </MasonryContext.Provider>
  );
}
