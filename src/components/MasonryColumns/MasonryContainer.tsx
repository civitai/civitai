import { createStyles, Container, ContainerProps } from '@mantine/core';
import React, { CSSProperties, useRef, createContext, useContext } from 'react';
import { useColumnCount, useContainerWidth } from '~/components/MasonryColumns/masonry.utils';
import {
  MasonryContextState,
  useMasonryContext,
} from '~/components/MasonryColumns/MasonryProvider';

type MasonryContainerProps = Omit<ContainerProps, 'children'> & {
  children: React.ReactNode | ((state: MasonryContainerState) => React.ReactNode);
};
type MasonryContainerState = MasonryContextState & {
  columnCount: number;
  combinedWidth: number;
  containerWidth: number;
};

const MasonryContainerContext = createContext<MasonryContainerState | null>(null);
export const useMasonryContainerContext = () => {
  const context = useContext(MasonryContainerContext);
  if (!context) throw new Error('MasonryContainerProvider not in tree');
  return context;
};

export function MasonryContainer({ children, ...containerProps }: MasonryContainerProps) {
  const containerRef = useRef(null);
  const masonryProviderState = useMasonryContext();
  const { columnWidth, columnGap, maxColumnCount } = masonryProviderState;

  const containerWidth = useContainerWidth(containerRef);
  const [columnCount, combinedWidth] = useColumnCount(
    containerWidth,
    columnWidth,
    columnGap,
    maxColumnCount
  );

  const { classes } = useStyles({
    columnWidth,
    columnGap,
    maxColumnCount,
  });

  const state = {
    containerWidth,
    columnCount,
    combinedWidth,
    ...masonryProviderState,
  };

  return (
    <Container {...containerProps}>
      <div ref={containerRef} className={classes.container}>
        <div
          style={{ width: columnCount > 1 && combinedWidth ? combinedWidth : undefined }}
          className={classes.queries}
        >
          <MasonryContainerContext.Provider value={state}>
            {typeof children === 'function' ? children(state) : children}
          </MasonryContainerContext.Provider>
        </div>
      </div>
    </Container>
  );
}

const useStyles = createStyles(
  (
    theme,
    {
      columnWidth,
      columnGap,
      maxColumnCount,
    }: {
      columnWidth: number;
      columnGap: number;
      maxColumnCount: number;
    }
  ) => {
    const maxWidth = columnWidth * maxColumnCount + columnGap * (maxColumnCount - 1);
    const containerQueries = [...Array(maxColumnCount)].reduce(
      (acc, value, index) => {
        const i = index + 1;
        if (i === 1) return { ...acc, width: '100%' };
        const combinedGapWidth = columnGap * (i - 1);
        const minWidth = columnWidth * i + combinedGapWidth;
        const width = columnWidth * i + combinedGapWidth;
        return {
          ...acc,
          [`@container masonry-container (min-width: ${minWidth}px)`]: {
            width,
          },
        };
      },
      { maxWidth } as CSSProperties
    );
    return {
      container: {
        containerType: 'inline-size',
        containerName: 'masonry-container',
      },
      queries: {
        margin: '0 auto',
        ...containerQueries,
      },
    };
  }
);
