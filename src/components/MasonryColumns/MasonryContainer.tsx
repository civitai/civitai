import { createStyles, ContainerProps, Box, BoxProps } from '@mantine/core';
import React, { CSSProperties } from 'react';
import {
  MasonryContextState,
  useMasonryContext,
} from '~/components/MasonryColumns/MasonryProvider';

type MasonryContainerProps = Omit<BoxProps, 'children'> & {
  children: React.ReactNode | ((state: MasonryContextState) => React.ReactNode);
};

export function MasonryContainer({ children, ...boxProps }: MasonryContainerProps) {
  const masonryProviderState = useMasonryContext();
  const { columnWidth, columnGap, maxColumnCount, columnCount, combinedWidth } =
    masonryProviderState;

  const { classes } = useStyles({
    columnWidth,
    columnGap,
    maxColumnCount,
  });

  const state = {
    ...masonryProviderState,
  };

  return (
    <Box px="md" {...boxProps}>
      <div className={classes.container}>
        <div
          style={{ width: columnCount > 1 && combinedWidth ? combinedWidth : undefined }}
          className={classes.queries}
        >
          {typeof children === 'function' ? children(state) : children}
        </div>
      </div>
    </Box>
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
