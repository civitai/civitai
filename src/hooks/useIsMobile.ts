import { useMantineTheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

export function useIsMobile() {
  const theme = useMantineTheme();

  return useMediaQuery(`(max-width: ${theme.breakpoints.sm - 1}px)`, true, {
    getInitialValueInEffect: false,
  });
}
