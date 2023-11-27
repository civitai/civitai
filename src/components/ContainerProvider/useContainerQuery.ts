import { MantineNumberSize } from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  useContainerProviderStore,
  useContainerContext,
} from '~/components/ContainerProvider/ContainerProvider';
import { mantineContainerSizes } from '~/utils/mantine-css-helpers';

export const useContainerQuery = ({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineNumberSize;
}) => {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const { nodeRef, containerName } = useContainerContext();
  const [value, setValue] = useState(false);

  useEffect(() => {
    if (nodeRef.current) {
      if (type === 'max-width') setValue(size > nodeRef.current?.offsetWidth);
      else if (type === 'min-width') setValue(size <= nodeRef.current?.offsetWidth);
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    useContainerProviderStore.subscribe((state) => {
      const entry = state[containerName];
      if (entry) {
        if (type === 'max-width') setValue(size > entry.inlineSize);
        else if (type === 'min-width') setValue(size <= entry.inlineSize);
      }
    });
  }, [size, type]); // eslint-disable-line

  return value;
};
