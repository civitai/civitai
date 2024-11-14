import { MantineSize } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export function useIsMobile(options?: { breakpoint: MantineSize }) {
  // const theme = useMantineTheme();
  const { breakpoint = 'sm' } = options || {};

  return useContainerQuery({ type: 'max-width', width: breakpoint });

  // return useMediaQuery(`(max-width: ${theme.breakpoints[breakpoint] - 1}px)`, false, {
  //   getInitialValueInEffect: false,
  // });
}

let isMobile: boolean | undefined;
export function isMobileDevice() {
  if (!isMobile)
    isMobile =
      typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  return isMobile;
}
