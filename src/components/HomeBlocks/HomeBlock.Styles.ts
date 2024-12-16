import { createStyles } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const useHomeBlockStyles = createStyles((theme, _, getRef) => {
  const expandButtonRef = getRef('expandButton');
  return {
    title: {
      fontSize: 32,

      [containerQuery.smallerThan('sm')]: {
        fontSize: 24,
      },
    },

    expandButton: {
      ref: expandButtonRef,
      height: 34,
    },

    header: {
      [containerQuery.smallerThan('sm')]: {
        display: 'block',
        [`& .${expandButtonRef}`]: {
          paddingLeft: 0,
          paddingRight: 0,
        },
      },
    },
  };
});

export const useHomeBlockGridStyles = createStyles<string, { count: number; rows: number }>(
  (theme, { count, rows }, getRef) => {
    return {
      gridRow: {
        gridAutoFlow: 'row',
      },
      grid: {
        display: 'grid',
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(auto-fill, 336px)`,
        // gap: theme.spacing.md,
        gridTemplateRows: `repeat(${rows}, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        gap: 0,
        margin: -8,

        // margin: -theme.spacing.md / 2,
        // marginTop: -theme.spacing.md,
        // paddingBottom: theme.spacing.md,

        // '& > *': {
        //   margin: theme.spacing.md / 2,
        // },

        [containerQuery.smallerThan('md')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count / 2}, 296px)`,
          gridTemplateRows: `repeat(${rows}, auto)`,
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
        },

        [containerQuery.smallerThan('sm')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count}, 296px)`,
          gridTemplateRows: 'auto',
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
          marginRight: -theme.spacing.md,
          marginLeft: -theme.spacing.md,
          paddingLeft: theme.spacing.md,

          '& > *': {
            scrollSnapAlign: 'center',
          },
        },
      },

      meta: {
        display: 'none',
        [containerQuery.smallerThan('md')]: {
          display: 'block',
        },
      },

      gridMeta: {
        gridColumn: '1 / span 2',
        display: 'flex',
        flexDirection: 'column',

        '& > *': {
          flex: 1,
        },

        [containerQuery.smallerThan('md')]: {
          display: 'none',
        },
      },

      gridCarousel: {
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(${count}, 296px)`,
        gridTemplateRows: 'auto',
        scrollSnapType: 'x mandatory',
        overflowX: 'auto',
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,
        paddingLeft: theme.spacing.md,

        '& > *': {
          scrollSnapAlign: 'center',
        },
      },
    };
  }
);
