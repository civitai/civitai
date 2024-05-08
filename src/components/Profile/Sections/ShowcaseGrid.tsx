import { createStyles } from '@mantine/core';
import React from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { containerQuery } from '~/utils/mantine-css-helpers';

type Props = {
  itemCount: number;
  rows: number;
  minWidth?: number;
  defaultWidth?: number;
  carousel?: boolean;
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

  if (props.carousel) {
    // Return a wrapped version:
    return (
      <div className={classes.container}>
        <div className={classes.scrollArea}>
          <div ref={ref} className={cx(classes.grid, classes.gridCarousel, className)}>
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={cx(classes.grid, className)}>
      {children}
    </div>
  );
}

export const useStyles = createStyles<string, Props>(
  (theme, { itemCount, rows, minWidth = 280, defaultWidth = 280 }, getRef) => {
    const carousel = {
      gridAutoRows: undefined,
      gridAutoFlow: 'column',
      gridTemplateColumns: `repeat(${itemCount}, ${defaultWidth}px)`,
      gridTemplateRows: 'auto',
      scrollSnapType: 'x mandatory',
      overflow: 'auto',
      overflowY: 'hidden',
      overflowX: 'visible',
      marginRight: -theme.spacing.md,
      marginLeft: -theme.spacing.md,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.md,

      '& > *': {
        scrollSnapAlign: 'center',
      },
    };

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
      gridCarousel: {
        gridAutoRows: undefined,
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(${itemCount}, ${defaultWidth}px)`,
        gridTemplateRows: 'auto',
        overflow: 'visible',
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,
        paddingLeft: theme.spacing.md,
        paddingRight: theme.spacing.md,

        '& > *': {
          scrollSnapAlign: 'initial',
        },

        [containerQuery.smallerThan('sm')]: {
          scrollSnapType: 'x mandatory',

          '& > *': {
            scrollSnapAlign: 'center',
          },
        },
      },

      container: {
        position: 'relative',
        '&:hover': {
          [`& .${getRef('scrollArea')}`]: {
            '&::-webkit-scrollbar': {
              opacity: 1,
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor:
                theme.colorScheme === 'dark'
                  ? theme.fn.rgba(theme.white, 0.5)
                  : theme.fn.rgba(theme.black, 0.5),
            },
          },
        },
      },
      scrollArea: {
        ref: getRef('scrollArea'),
        overflow: 'auto',
        scrollSnapType: 'auto',
        [containerQuery.smallerThan('sm')]: {
          scrollSnapType: 'x mandatory',
        },

        '&::-webkit-scrollbar': {
          background: 'transparent',
          opacity: 0,
          height: 8,
        },
        '&::-webkit-scrollbar-thumb': {
          borderRadius: 4,
        },
      },
    };
  }
);
