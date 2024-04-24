import { Sx, MantineTheme } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ProfileBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';

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

export const applyCosmeticThemeColors =
  (opts: ProfileBackgroundCosmetic['data']) => (theme: MantineTheme) => ({
    root: {
      backgroundColor: `${opts.backgroundColor ?? theme.fn.rgba('#000', 0.31)} !important`,
      color: `${opts.textColor ?? theme.colors.gray[0]} !important`,

      [`&:hover`]: {
        backgroundColor: `${theme.fn.lighten(
          opts.backgroundColor ?? theme.fn.rgba('#000', 0.31),
          0.2
        )} !important`,
      },
    },
  });
