import type { MantineSize } from '@mantine/core';
import { useContainerQuery, useMediaQuery } from '~/components/ContainerProvider/useContainerQuery';

export function useIsMobile(options?: { breakpoint?: MantineSize; type?: 'media' | 'container' }) {
  // const theme = useMantineTheme();
  const { breakpoint = 'sm' } = options || {};

  const useHook = options?.type === 'media' ? useMediaQuery : useContainerQuery;

  return useHook({ type: 'max-width', width: breakpoint });
}

let isMobile: boolean | undefined;
export function isMobileDevice() {
  if (isMobile === undefined)
    isMobile =
      typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  return isMobile;
}
