import { MantineNumberSize } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import {
  useContainerProviderStore,
  useContainerContext,
} from '~/components/ContainerProvider/ContainerProvider';
import { mantineContainerSizes } from '~/utils/mantine-css-helpers';

export const useContainerQuery = ({
  type,
  width,
  containerName,
}: {
  type: 'min-width' | 'max-width';
  width: MantineNumberSize;
  containerName?: string;
}) => {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const { nodeRef, ...context } = useContainerContext();

  const value = useContainerProviderStore(
    useCallback(
      (state) => {
        const { inlineSize = nodeRef.current?.offsetWidth ?? 0 } =
          state[containerName ?? context.containerName] ?? {};

        if (type === 'max-width') return size > inlineSize;
        else return size <= inlineSize;
      },
      [size, type, containerName]
    )
  );

  return value;
};
