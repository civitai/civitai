import type { MantineSpacing } from '@mantine/core';
import { useMediaQuery as useMantineMediaQuery } from '@mantine/hooks';
import { useCallback, useMemo } from 'react';
import {
  useContainerContext,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';
import { mantineContainerSizes } from '~/utils/mantine-css-helpers';

export function useContainerSize() {
  const { nodeRef, containerName } = useContainerContext();
  return useContainerProviderStore(
    useCallback((state) => {
      return (
        state[containerName] ?? {
          inlineSize: nodeRef.current?.offsetWidth ?? 0,
          blockSize: nodeRef.current?.offsetHeight ?? 0,
        }
      );
    }, [])
  );
}

export function useContainerQuery({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineSpacing;
}) {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const { inlineSize } = useContainerSize();

  return useMemo(() => {
    if (inlineSize === 0) return false;
    if (type === 'max-width') return size > inlineSize;
    else return size <= inlineSize;
  }, [inlineSize, type, size]);
}

export function useMediaQuery({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineSpacing;
}) {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const queryString =
    type === 'min-width' ? `(min-width: ${size}px)` : `(max-width: ${size - 1}px)`;
  return useMantineMediaQuery(queryString, false, { getInitialValueInEffect: false });
}
