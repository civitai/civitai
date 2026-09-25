import type { MantineSize } from '@mantine/core';
import { useSyncExternalStore } from 'react';
import { useContainerQuery, useMediaQuery } from '~/components/ContainerProvider/useContainerQuery';

export function useIsMobile(options?: { breakpoint?: MantineSize; type?: 'media' | 'container' }) {
  // const theme = useMantineTheme();
  const { breakpoint = 'sm' } = options || {};

  const useHook = options?.type === 'media' ? useMediaQuery : useContainerQuery;

  return useHook({ type: 'max-width', width: breakpoint });
}

const noopSubscribe = () => () => undefined;

/** `undefined` during SSR and hydration, where `isMobileDevice()` would disagree with the server. */
export function useIsMobileDevice() {
  return useSyncExternalStore<boolean | undefined>(noopSubscribe, isMobileDevice, () => undefined);
}

let isMobile: boolean | undefined;
export function isMobileDevice() {
  if (isMobile === undefined)
    isMobile =
      typeof window !== 'undefined' &&
      // Before we were using touchpoints which broke laptops or PC with touchscreens / touchpads.
      ('ontouchstart' in window || /Mobi|Android/i.test(navigator.userAgent));
  return isMobile;
}
