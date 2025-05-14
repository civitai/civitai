import { lighten, MantineTheme, rgba } from '@mantine/core';
import { ProfileBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';

export const applyCosmeticThemeColors =
  (opts: ProfileBackgroundCosmetic['data']) => (theme: MantineTheme) => ({
    root: {
      backgroundColor: `${opts.backgroundColor ?? rgba('#000', 0.31)} !important`,
      color: `${opts.textColor ?? theme.colors.gray[0]} !important`,

      [`&:hover`]: {
        backgroundColor: `${lighten(opts.backgroundColor ?? rgba('#000', 0.31), 0.2)} !important`,
      },
    },
  });
