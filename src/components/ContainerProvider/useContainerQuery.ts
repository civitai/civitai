import type { MantineNumberSize } from '@mantine/core';
import { useMediaQuery as useMantineMediaQuery } from '@mantine/hooks';
import { useCallback } from 'react';
import {
  useContainerContext,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';
import { mantineContainerSizes } from '~/utils/mantine-css-helpers';

export function useContainerQuery({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineNumberSize;
}) {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const { nodeRef, ...context } = useContainerContext();

  const value = useContainerProviderStore(
    useCallback(
      (state) => {
        const { inlineSize = nodeRef.current?.offsetWidth ?? 0 } =
          state[context.containerName] ?? {};

        // otherwise, this will return true at first
        if (inlineSize === 0) return false;

        if (type === 'max-width') return size > inlineSize;
        else return size <= inlineSize;
      },
      [size, type]
    )
  );

  return value;
}

export function useMediaQuery({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineNumberSize;
}) {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const queryString =
    type === 'min-width' ? `(min-width: ${size}px)` : `(max-width: ${size - 1}px)`;
  return useMantineMediaQuery(queryString, false, { getInitialValueInEffect: false });
}
