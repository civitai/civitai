import { Sx } from '@mantine/core';

export const hideMobile: Sx = (theme) => ({
  [theme.fn.smallerThan('xs')]: {
    display: 'none',
  },
});

export const showMobile: Sx = (theme) => ({
  [theme.fn.largerThan('xs')]: {
    display: 'none',
  },
});
