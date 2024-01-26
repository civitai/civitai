import { createStyles } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const useFeedFiltersStyles = createStyles((theme) => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
  subnavDropdown: {
    background: 'transparent',
    color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[8],
    height: 32,
    [`&:hover`]: {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[3],
    },
    [`&[data-expanded="true"]`]: {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4],
      [`&:hover`]: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4],
      },
    },
  },
}));
