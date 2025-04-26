import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  title: {
    fontSize: '32px',
    [containerQuery.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
  profileSection: {
    paddingLeft: 'var(--mantine-spacing-md)',
    paddingRight: 'var(--mantine-spacing-md)',
    paddingTop: 'var(--mantine-spacing-xl)',
    paddingBottom: 'var(--mantine-spacing-xl)',
    marginRight: 'calc(var(--mantine-spacing-md) * -1)',
    marginLeft: 'calc(var(--mantine-spacing-md) * -1)',

    '&:nth-of-type(even)': {
      background: 'var(--mantine-color-dark-8)',
    },

    '&:hover': {
      '&::-webkit-scrollbar': {
        opacity: 1,
      },
      '&::-webkit-scrollbar-thumb': {
        backgroundColor: 'var(--mantine-color-white)',
        opacity: 0.5,
      },
    },
  },
  loader: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 101,
  },
  nullState: {
    position: 'relative',
  },
  loading: {
    position: 'relative',

    '&::after': {
      position: 'absolute',
      height: '100%',
      width: '100%',
      top: 0,
      left: 0,
      content: '""',
      background: 'rgba(0,0,0, 0.3)',
      zIndex: 100,
    },
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
    columnGap: 'var(--mantine-spacing-md)',
    gridTemplateRows: 'repeat(2, auto)',
    gridAutoRows: 0,
    overflow: 'hidden',
    marginTop: 'calc(var(--mantine-spacing-md) * -1)',
    paddingBottom: 'var(--mantine-spacing-md)',

    '&::-webkit-scrollbar': {
      background: 'transparent',
      opacity: 0,
      height: 8,
    },
    '&::-webkit-scrollbar-thumb': {
      borderRadius: 4,
    },

    '& > *': {
      marginTop: 'var(--mantine-spacing-md)',
    },

    [containerQuery.smallerThan('sm')]: {
      gridAutoFlow: 'column',
      gridTemplateColumns: 'repeat(4, 280px)',
      gridTemplateRows: 'auto',
      scrollSnapType: 'x mandatory',
      overflowX: 'auto',
      marginRight: 'calc(var(--mantine-spacing-md) * -1)',
      marginLeft: 'calc(var(--mantine-spacing-md) * -1)',
      paddingLeft: 'var(--mantine-spacing-md)',
      paddingRight: 'var(--mantine-spacing-md)',

      '& > *': {
        scrollSnapAlign: 'center',
      },
    },
  },
};
