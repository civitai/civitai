import { createStyles, Box, BoxProps } from '@mantine/core';
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

  const { classes, cx } = useStyles({
    columnWidth,
    columnGap,
    maxColumnCount,
  });

  return (
    <Box px="md" {...boxProps} className={cx(classes.container, boxProps.className)}>
      {typeof children === 'function' ? children(masonryProviderState) : children}
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
          width: '100%',
          [`@container masonry-container (min-width: ${minWidth}px)`]: {
            width,
          },
        };
      },
      { maxWidth } as CSSProperties
    );
    return {
      container: {
        // containerType: 'inline-size',
        // containerName: 'masonry-container',
        margin: '0 auto',
        ...containerQueries,
      },
    };
  }
);
