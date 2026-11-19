import type { MantineSize } from '@mantine/core';
import { useMediaQuery as useMantineMediaQuery } from '@mantine/hooks';
import { useSyncExternalStore } from 'react';
import { useContainerQuery, useMediaQuery } from '~/components/ContainerProvider/useContainerQuery';
import { MOBILE_USER_AGENT_PATTERN } from '~/shared/utils/mobile-user-agent';

export function useIsMobile(options?: {
  breakpoint?: MantineSize;
  type?: 'media' | 'container';
  /** Container type only: the answer until the container is measured (server + hydration). */
  unmeasured?: boolean;
}) {
  const { breakpoint = 'sm', unmeasured } = options || {};

  const useHook = options?.type === 'media' ? useMediaQuery : useContainerQuery;

  return useHook({ type: 'max-width', width: breakpoint, unmeasured });
}

/** Phone-like input: no hover and a coarse primary pointer. False until mounted, matching the server. */
export function useHasCoarsePointer() {
  return useMantineMediaQuery('(hover: none) and (pointer: coarse)') === true;
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
      ('ontouchstart' in window || MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent));
  return isMobile;
}
