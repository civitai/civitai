import { createStyles } from '@mantine/core';
import React from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { containerQuery } from '~/utils/mantine-css-helpers';

type Props = {
  itemCount: number;
  rows: number;
  minWidth?: number;
  defaultWidth?: number;
};

export function ShowcaseGrid({
  children,
  className,
  ...props
}: Props & { children: React.ReactNode; className?: string }) {
  const { classes, cx } = useStyles(props);
  const ref = useResizeObserver<HTMLDivElement>((entry) => {
    const children = [...entry.target.childNodes] as HTMLElement[];
    for (const child of children) {
      const { height } = child.getBoundingClientRect();
      if (height === 0) child.style.visibility = 'hidden';
      else child.style.removeProperty('visibility');
    }
  });

  return (
    <div ref={ref} className={cx(classes.grid, className)}>
      {children}
    </div>
  );
}

export const useStyles = createStyles<string, Props>(
  (theme, { itemCount, rows, minWidth = 280, defaultWidth = 280 }) => {
    return {
      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
        columnGap: theme.spacing.md,
        gridTemplateRows: `repeat(${rows ?? '2'}, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        marginTop: -theme.spacing.md,
        paddingBottom: theme.spacing.md,

        '&::-webkit-scrollbar': {
          background: 'transparent',
          opacity: 0,
          height: 8,
        },
        '&::-webkit-scrollbar-thumb': {
          borderRadius: 4,
        },

        '& > *': {
          marginTop: theme.spacing.md,
        },

        [containerQuery.smallerThan('sm')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${itemCount}, ${defaultWidth}px)`,
          gridTemplateRows: 'auto',
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
          marginRight: -theme.spacing.md,
          marginLeft: -theme.spacing.md,
          paddingLeft: theme.spacing.md,
          paddingRight: theme.spacing.md,

          '& > *': {
            scrollSnapAlign: 'center',
          },
        },
      },
    };
  }
);
