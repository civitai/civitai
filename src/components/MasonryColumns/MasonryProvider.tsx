import React, { createContext, useContext } from 'react';

export type MasonryContextState = {
  columnWidth: number;
  columnGap: number;
  rowGap: number;
  maxColumnCount: number;
  maxSingleColumnWidth?: number;
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
};

export function MasonryProvider({
  children,
  columnWidth,
  maxColumnCount,
  gap = 16,
  columnGap = gap,
  rowGap = gap,
  maxSingleColumnWidth = columnWidth,
}: Props) {
  return (
    <MasonryContext.Provider
      value={{
        columnWidth,
        columnGap,
        rowGap,
        maxColumnCount,
        maxSingleColumnWidth,
      }}
    >
      {children}
    </MasonryContext.Provider>
  );
}
