import { createStyles } from '@mantine/core';

export const useFeedFiltersStyles = createStyles((theme) => ({
  filtersWrapper: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));
