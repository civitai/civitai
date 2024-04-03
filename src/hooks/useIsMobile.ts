import { MantineSize, useMantineTheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export function useIsMobile(options?: { breakpoint: MantineSize }) {
  // const theme = useMantineTheme();
  const { breakpoint = 'sm' } = options || {};

  return useContainerQuery({ type: 'max-width', width: breakpoint });

  // return useMediaQuery(`(max-width: ${theme.breakpoints[breakpoint] - 1}px)`, false, {
  //   getInitialValueInEffect: false,
  // });
}
