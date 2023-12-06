import { Sx } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const hideMobile: Sx = (theme) => ({
  [containerQuery.smallerThan('xs')]: {
    display: 'none',
  },
});

export const showMobile: Sx = (theme) => ({
  [containerQuery.largerThan('xs')]: {
    display: 'none',
  },
});
