import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  root: {
    flexGrow: 1,

    [containerQuery.smallerThan('md')]: {
      height: '100%',
      flexGrow: 1,
    },
  },
  wrapper: {
    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    borderRadius: 0,

    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  dropdown: {
    [containerQuery.smallerThan('sm')]: {
      marginTop: '-7px',
    },
  },
  targetSelectorRoot: {
    width: '110px',

    [containerQuery.smallerThan('sm')]: {
      width: '25%',
    },
  },
  targetSelectorInput: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    backgroundColor: 'var(--mantine-color-dark-8)',
    paddingRight: '18px',

    '&:not(:focus)': {
      borderRightStyle: 'none',
    },

    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  targetSelectorRightSection: {
    pointerEvents: 'none',
  },
  searchButton: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    backgroundColor: 'var(--mantine-color-dark-8)',
    color: 'var(--mantine-color-white)',

    '&:hover': {
      backgroundColor: 'var(--mantine-color-dark-7)',
    },

    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },
};
