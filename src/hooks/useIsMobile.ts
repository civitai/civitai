import { MantineSize, useMantineTheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

export function useIsMobile(options?: { breakpoint: MantineSize }) {
  const theme = useMantineTheme();
  const { breakpoint = 'sm' } = options || {};

  return useMediaQuery(`(max-width: ${theme.breakpoints[breakpoint] - 1}px)`, false, {
    getInitialValueInEffect: false,
  });
}
