import { MantineNumberSize } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useNodeContext } from '~/components/NodeProvider/NodeProvider';
import { mantineContainerSizes } from '~/utils/mantine-css-helpers';

export const useContainerQuery = ({
  type,
  width,
}: {
  type: 'min-width' | 'max-width';
  width: MantineNumberSize;
}) => {
  const size = typeof width === 'string' ? mantineContainerSizes[width] : width;
  const { nodeRef, emitterRef } = useNodeContext();
  const [value, setValue] = useState(false);

  useEffect(() => {
    if (nodeRef.current) {
      if (type === 'max-width') setValue(size > nodeRef.current?.offsetWidth);
      else if (type === 'min-width') setValue(size <= nodeRef.current?.offsetWidth);
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    const emitter = emitterRef.current;
    if (!emitter) return;
    const callback = emitter.on('resize', (entry) => {
      if (type === 'max-width') setValue(size > entry.contentBoxSize[0].inlineSize);
      else if (type === 'min-width') setValue(size <= entry.contentBoxSize[0].inlineSize);
    });
    return () => {
      emitter.off('resize', callback);
    };
  }, [size, type]); // eslint-disable-line

  return value;
};
